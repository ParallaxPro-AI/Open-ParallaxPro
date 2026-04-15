import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { config } from '../../config.js';
import { getAvailableAgents } from './pipeline/cli_availability.js';

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
function hasDirectApiConfig(): boolean {
    return !!(config.ai.baseUrl && config.ai.model && config.ai.apiKey);
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
        'Examples: "space-shooter", "zombie-survival", "block-world", "racing-game".';

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

export async function callLLMStream(
    messages: LLMMessage[],
    callbacks: LLMStreamCallbacks,
    abortSignal?: AbortSignal,
): Promise<void> {
    if (!hasDirectApiConfig()) {
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

function pickFallbackCLI(): FallbackCLI | null {
    const installed = getAvailableAgents();
    if (installed.length === 0) return null;
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
        };
    }
    if (cli === 'codex') {
        return {
            args: [
                'exec',
                '--json',
                '--skip-git-repo-check',
                '--dangerously-bypass-approvals-and-sandbox',
                '-c', 'model_reasoning_effort="minimal"',
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
    };
}

async function runCLIForText(
    messages: LLMMessage[],
    onChunk: (text: string) => void,
    abortSignal?: AbortSignal,
): Promise<{ text: string; error?: string }> {
    const cli = pickFallbackCLI();
    if (!cli) {
        return { text: '', error: 'No LLM configured (AI_BASE_URL unset) and no fallback CLI installed.' };
    }
    const prompt = flattenMessagesForCLI(messages);
    const { args, extract } = buildCLIInvocation(cli, prompt);

    // Empty temp dir so the agent has no project files to poke at.
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppai-chat-'));

    try {
        return await new Promise<{ text: string; error?: string }>((resolve) => {
            const proc = spawn(cli, args, {
                cwd: sandboxDir,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, HOME: process.env.HOME || '/tmp' },
            });

            let fullText = '';
            let stderr = '';

            if (abortSignal) {
                if (abortSignal.aborted) { proc.kill('SIGTERM'); resolve({ text: '', error: 'Aborted' }); return; }
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
                    } catch { /* non-JSON line — ignore */ }
                }
            });

            proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

            proc.on('close', (code) => {
                if (code === 0 || code === null) {
                    resolve({ text: fullText });
                } else {
                    console.error(`[LLM] CLI fallback ${cli} exited ${code}. stderr: ${stderr.slice(0, 500)}`);
                    resolve({ text: fullText, error: `CLI fallback ${cli} exited with code ${code}` });
                }
            });

            proc.on('error', (err) => {
                resolve({ text: '', error: `Failed to spawn ${cli}: ${err.message}` });
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
): Promise<void> {
    const result = await runCLIForText(messages, callbacks.onChunk, abortSignal);
    if (result.error && !result.text) {
        callbacks.onError(result.error);
        return;
    }
    callbacks.onDone(result.text);
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
