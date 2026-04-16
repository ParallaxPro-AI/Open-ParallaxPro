import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../../config.js';
import { getAvailableAgents } from './pipeline/cli_availability.js';
import { wrapSpawn } from './pipeline/docker_sandbox.js';

export interface LLMMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface TokenUsage {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
}

export interface LLMStreamCallbacks {
    onChunk: (text: string) => void;
    onDone: (fullText: string, usage?: TokenUsage) => void;
    onError: (error: string) => void;
}

/**
 * True when a direct OpenAI-compatible API is configured. Otherwise the
 * backend falls back to driving an installed CLI (claude / codex / opencode
 * / copilot) for text completion — slower and agentic by nature, but lets
 * first-time users run the engine without signing up for an API key.
 */
export function isDirectApiConfigured(): boolean {
    return !!(config.ai.baseUrl && config.ai.model && config.ai.apiKey);
}

function hasDirectApiConfig(): boolean {
    return isDirectApiConfigured();
}

/**
 * Ask the LLM for a short kebab-case project name derived from a user prompt.
 * Non-streaming, capped by a hard timeout. Returns null on timeout, API error,
 * or empty/unusable output so callers can fall back to a default name.
 */
export async function generateProjectName(prompt: string, timeoutMs: number = 10000): Promise<string | null> {
    if (!prompt.trim()) return null;

    const systemPrompt =
        'Generate a short (1-4 words) kebab-case project name for a game based on the user\'s description. ' +
        'Reply with ONLY the name — no quotes, no punctuation, no explanation. ' +
        'Use lowercase letters, digits, and hyphens only. ' +
        'Examples: "space-shooter", "zombie-survival", "block-world", "racing-game". ' +
        'If the user\'s message is not a meaningful game description (e.g. "hi", "hello", "asdf", "test", random words, greetings, or anything too vague to derive a game name from), reply with exactly SKIP.';

    if (!hasDirectApiConfig()) {
        const text = await callCLIForTextCollected(
            [{ role: 'system', content: systemPrompt }, { role: 'user', content: prompt }],
            timeoutMs,
        );
        return text ? sanitizeProjectName(text) : null;
    }

    const { baseUrl, model, apiKey } = config.ai;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                // Reasoning models (e.g. openai/gpt-oss-120b on Groq) eat
                // most of the budget on chain-of-thought before the final
                // name — 2048 gives them plenty of headroom while still
                // bounded by the 10s client timeout.
                max_tokens: 2048,
                stream: false,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt },
                ],
            }),
            signal: controller.signal,
        });
        if (!res.ok) return null;
        const data: any = await res.json();
        const raw = data?.choices?.[0]?.message?.content;
        if (typeof raw !== 'string') return null;
        return sanitizeProjectName(raw);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

function sanitizeProjectName(raw: string): string | null {
    if (raw.trim().toLowerCase() === 'skip') return null;
    const cleaned = raw
        .toLowerCase()
        .replace(/["'`]/g, '')
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40)
        .replace(/-+$/, '');
    return cleaned.length >= 2 ? cleaned : null;
}

/**
 * Chat-path routing:
 *   - `chatAgent === 'llm_api'` → force the direct API path. Errors out if
 *     AI_BASE_URL / AI_MODEL / AI_API_KEY aren't all set.
 *   - `chatAgent` is a known CLI id → force the CLI fallback path using
 *     that specific CLI (errors if it isn't installed).
 *   - `chatAgent` unset → auto: direct API when configured, else first
 *     installed CLI.
 */
export async function callLLMStream(
    messages: LLMMessage[],
    callbacks: LLMStreamCallbacks,
    abortSignal?: AbortSignal,
    chatAgent?: string,
): Promise<void> {
    if (chatAgent === 'llm_api') {
        if (!hasDirectApiConfig()) {
            callbacks.onError('Chat Agent is set to "LLM API" but AI_BASE_URL / AI_MODEL / AI_API_KEY are not configured.');
            return;
        }
    } else if (chatAgent && chatAgent !== 'llm_api') {
        // Caller asked for a specific CLI — honor it (or fail loudly).
        return callCLIForTextStream(messages, callbacks, abortSignal, chatAgent);
    } else if (!hasDirectApiConfig()) {
        // No override and no API config — auto-fallback to first CLI.
        return callCLIForTextStream(messages, callbacks, abortSignal);
    }

    const { baseUrl, model, apiKey, maxTokens } = config.ai;

    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                max_tokens: maxTokens,
                stream: true,
                stream_options: { include_usage: true },
                messages: messages.map(m => ({ role: m.role, content: m.content })),
            }),
            signal: abortSignal,
        });

        if (!res.ok) {
            const err = await res.text();
            callbacks.onError(`LLM API error ${res.status}: ${err}`);
            return;
        }

        let fullText = '';
        let usage: TokenUsage | undefined;
        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6);
                if (data === '[DONE]') continue;

                try {
                    const event = JSON.parse(data);
                    const content = event.choices?.[0]?.delta?.content;
                    if (content) {
                        fullText += content;
                        callbacks.onChunk(content);
                    }
                    // Extract usage from final streaming event (OpenAI-compatible)
                    if (event.usage) {
                        usage = {
                            promptTokens: event.usage.prompt_tokens ?? 0,
                            completionTokens: event.usage.completion_tokens ?? 0,
                            totalTokens: event.usage.total_tokens ?? 0,
                        };
                    }
                } catch {}
            }
        }

        callbacks.onDone(fullText, usage);
    } catch (e: any) {
        if (e.name === 'AbortError') return;
        callbacks.onError(e.message ?? 'LLM request failed');
    }
}

// ─── CLI fallback ───────────────────────────────────────────────────────────
//
// When AI_BASE_URL / AI_MODEL / AI_API_KEY aren't set, we drive an installed
// agent CLI (claude / codex / opencode / copilot) as a text-completion
// proxy. The CLIs are agentic by design, which is imperfect for chat: the
// model may try to invoke its own tools instead of emitting our <<<TOOL>>>
// markers as text. We mitigate by running in an empty temp directory (so
// there are no files to poke at) and by capping tool budgets where possible
// (`claude --max-turns 1`, `copilot --available-tools=""`).
//
// Fallback CLI pick: first installed per PROBES order (claude → codex →
// opencode → copilot). Claude's chat feel is closest to a raw completion
// so it's preferred when present. Pick is per-call so adding/removing a
// CLI takes effect immediately.

type FallbackCLI = 'claude' | 'codex' | 'opencode' | 'copilot';
const VALID_FALLBACK_CLIS: ReadonlySet<FallbackCLI> = new Set(['claude', 'codex', 'opencode', 'copilot']);

/**
 * Pick the CLI to use for text completion. When `preferred` is supplied and
 * installed, returns it; otherwise returns the first installed CLI in
 * probe order (claude → codex → opencode → copilot). Returns null when
 * no fallback CLI is available.
 */
function pickFallbackCLI(preferred?: string): FallbackCLI | null {
    const installed = getAvailableAgents();
    if (installed.length === 0) return null;
    if (preferred && VALID_FALLBACK_CLIS.has(preferred as FallbackCLI)) {
        const hit = installed.find(a => a.id === preferred);
        if (hit) return preferred as FallbackCLI;
    }
    return installed[0].id as FallbackCLI;
}

/**
 * Flatten messages[] into a single prompt string. CLIs take one prompt arg —
 * no native messages concept — so we inline roles with headers the model
 * can read.
 */
function flattenMessagesForCLI(messages: LLMMessage[]): string {
    const parts: string[] = [];
    for (const m of messages) {
        const tag = m.role === 'system' ? 'SYSTEM' : m.role === 'user' ? 'USER' : 'ASSISTANT';
        parts.push(`[${tag}]\n${m.content}`);
    }
    parts.push('[ASSISTANT]');
    return parts.join('\n\n');
}

interface CLIInvocation {
    args: string[];
    /** Extract a text chunk from one JSONL event (or return null to skip). */
    extract: (event: any) => string | null;
    /** Extract incremental USD cost from one JSONL event (or return 0). */
    extractCost: (event: any) => number;
}

function buildCLIInvocation(cli: FallbackCLI, prompt: string): CLIInvocation {
    if (cli === 'claude') {
        return {
            args: [
                '-p', prompt,
                '--output-format', 'stream-json',
                '--verbose',
                '--model', 'sonnet',
                '--max-turns', '1',
                '--dangerously-skip-permissions',
            ],
            extract: (event) => {
                if (event.type !== 'assistant') return null;
                const content = event.message?.content;
                if (!Array.isArray(content)) return null;
                let out = '';
                for (const block of content) {
                    if (block.type === 'text' && typeof block.text === 'string') out += block.text;
                }
                return out || null;
            },
            extractCost: (event) => event.type === 'result' ? (event.total_cost_usd || 0) : 0,
        };
    }
    if (cli === 'codex') {
        return {
            args: [
                'exec',
                '--json',
                '--skip-git-repo-check',
                '--dangerously-bypass-approvals-and-sandbox',
                // 'minimal' trips the provider ("web_search cannot be used
                // with reasoning.effort 'minimal'"); 'low' is the lowest
                // setting that keeps codex's default tool set working.
                '-c', 'model_reasoning_effort="low"',
                prompt,
            ],
            // Codex emits item.completed with agent_message items. Stream the
            // deltas isn't exposed, so we only see full messages — fine for
            // fallback; the user just gets the final answer in one burst.
            extract: (event) => {
                if (event.type !== 'item.completed') return null;
                const item = event.item;
                if (item?.type !== 'agent_message' || typeof item.text !== 'string') return null;
                return item.text;
            },
            extractCost: () => 0, // Codex doesn't report cost
        };
    }
    if (cli === 'opencode') {
        return {
            args: ['run', '--format', 'json', prompt],
            extract: (event) => {
                if (event.type !== 'text') return null;
                const t = event.part?.text;
                return typeof t === 'string' ? t : null;
            },
            extractCost: (event) => {
                if (event.type === 'step_finish') {
                    const c = event.part?.cost;
                    return typeof c === 'number' ? c : 0;
                }
                return 0;
            },
        };
    }
    // copilot
    return {
        args: [
            '-p', prompt,
            '--output-format', 'json',
            '--allow-all',
            '--no-ask-user',
            '--no-auto-update',
            '--log-level', 'none',
        ],
        extract: (event) => {
            // Prefer streaming deltas; fall back to final assistant.message.
            if (event.type === 'assistant.message_delta') {
                const d = event.data?.deltaContent;
                return typeof d === 'string' ? d : null;
            }
            return null;
        },
        extractCost: () => 0, // Copilot doesn't report cost
    };
}

async function runCLIForText(
    messages: LLMMessage[],
    onChunk: (text: string) => void,
    abortSignal?: AbortSignal,
    preferredCLI?: string,
): Promise<{ text: string; costUsd: number; error?: string }> {
    if (preferredCLI && VALID_FALLBACK_CLIS.has(preferredCLI as FallbackCLI)) {
        const installed = getAvailableAgents().some(a => a.id === preferredCLI);
        if (!installed) {
            return { text: '', costUsd: 0, error: `Chat Agent "${preferredCLI}" is not installed on this server.` };
        }
    }
    const cli = pickFallbackCLI(preferredCLI);
    if (!cli) {
        return { text: '', costUsd: 0, error: 'No LLM configured (AI_BASE_URL unset) and no fallback CLI installed.' };
    }
    const prompt = flattenMessagesForCLI(messages);
    const { args, extract, extractCost } = buildCLIInvocation(cli, prompt);

    // Empty temp dir so the agent has no project files to poke at.
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppai-chat-'));

    // Wrap in Docker if DOCKER_SANDBOX is enabled.
    const wrapped = wrapSpawn(cli as any, cli, args, sandboxDir);

    try {
        return await new Promise<{ text: string; costUsd: number; error?: string }>((resolve) => {
            const proc = spawn(wrapped.command, wrapped.args, {
                cwd: sandboxDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, HOME: process.env.HOME || '/tmp' },
            });

            let fullText = '';
            let costUsd = 0;
            let stderr = '';

            if (abortSignal) {
                if (abortSignal.aborted) { proc.kill('SIGTERM'); resolve({ text: '', costUsd: 0, error: 'Aborted' }); return; }
                abortSignal.addEventListener('abort', () => proc.kill('SIGTERM'), { once: true });
            }

            let buffer = '';
            proc.stdout.on('data', (c: Buffer) => {
                buffer += c.toString();
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';
                for (const line of lines) {
                    if (!line.trim()) continue;
                    try {
                        const event = JSON.parse(line);
                        const chunk = extract(event);
                        if (chunk) {
                            fullText += chunk;
                            onChunk(chunk);
                        }
                        costUsd += extractCost(event);
                    } catch { /* non-JSON line — ignore */ }
                }
            });

            proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

            proc.on('close', (code) => {
                if (code === 0 || code === null) {
                    resolve({ text: fullText, costUsd });
                } else {
                    console.error(`[LLM] CLI fallback ${cli} exited ${code}. stderr: ${stderr.slice(0, 500)}`);
                    resolve({ text: fullText, costUsd, error: `CLI fallback ${cli} exited with code ${code}` });
                }
            });

            proc.on('error', (err) => {
                resolve({ text: '', costUsd: 0, error: `Failed to spawn ${cli}: ${err.message}` });
            });
        });
    } finally {
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    }
}

async function callCLIForTextStream(
    messages: LLMMessage[],
    callbacks: LLMStreamCallbacks,
    abortSignal?: AbortSignal,
    preferredCLI?: string,
): Promise<void> {
    const result = await runCLIForText(messages, callbacks.onChunk, abortSignal, preferredCLI);
    if (result.error && !result.text) {
        callbacks.onError(result.error);
        return;
    }
    // Convert costUsd to a synthetic TokenUsage so onLLMUsage fires.
    // CLIs don't report token counts, but costUsd lets the usage plugin
    // estimate consumption for budget enforcement.
    const usage: TokenUsage | undefined = result.costUsd > 0
        ? { promptTokens: 0, completionTokens: 0, totalTokens: 0, costUsd: result.costUsd } as any
        : undefined;
    callbacks.onDone(result.text, usage);
}

/**
 * Collect all CLI output into a single string, with a hard timeout. Used
 * by `generateProjectName` — the caller just needs the final text, not a
 * live stream.
 */
async function callCLIForTextCollected(messages: LLMMessage[], timeoutMs: number): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const result = await runCLIForText(messages, () => { /* discard chunks */ }, controller.signal);
        return result.text || null;
    } finally {
        clearTimeout(timer);
    }
}
