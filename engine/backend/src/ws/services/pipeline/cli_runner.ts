/**
 * cli_runner.ts — shared wrapper around CLI coding agents (claude, codex).
 *
 * Both cli_fixer and cli_creator spawn an agent inside a /tmp sandbox to
 * read/edit project files. The agents differ in binary, argument shape,
 * and JSON event schema, but the contract the callers need is uniform:
 * a prompt goes in, a final text blob + token/$ usage comes out, with
 * status callbacks fired as the agent uses tools.
 *
 * Status callbacks receive a short human-readable string (e.g. "Analyzing
 * game code...") — the caller is responsible for mapping those to the
 * user-visible flavor ("Creator is building..." vs "Fixer is analyzing...").
 */

import { spawn } from 'child_process';
import { config } from '../../../config.js';
import { getAvailableAgents } from './cli_availability.js';

export interface CLIRunResult {
    /** Final agent message — shown to the user as the summary. */
    text: string;
    /** Dollar cost reported by the CLI, if available. Codex does not report it. */
    costUsd: number;
}

export type StatusMapper = (activity: CLIActivity) => string | undefined;

/** Normalized activity the caller maps to a status string. */
export type CLIActivity =
    | { kind: 'read' }
    | { kind: 'edit' }
    | { kind: 'write' }
    | { kind: 'search' }
    | { kind: 'bash' }
    | { kind: 'other' };

export interface SpawnOptions {
    sandboxDir: string;
    prompt: string;
    /** Claude only — codex uses its own per-request cap from config.toml. */
    maxTurns: number;
    statusMapper: StatusMapper;
    sendStatus?: (msg: string) => void;
    abortSignal?: AbortSignal;
    /**
     * Override which CLI to use for this one call. Accepts 'claude' | 'codex' |
     * 'opencode'. When unset, falls back to the first CLI detected at startup
     * (probe order: claude → codex → opencode).
     */
    cliOverride?: string;
}

type CLIName = 'claude' | 'codex' | 'opencode';

/**
 * Pick the CLI for this call. Preference order:
 *   1. Explicit `cliOverride` if set (per-message pick / per-project setting).
 *   2. First agent detected at startup — `PROBES` orders claude → codex →
 *      opencode, so claude wins whenever it's installed.
 * Throws if nothing is installed.
 */
function resolveCLI(cliOverride?: string): CLIName {
    if (cliOverride === 'claude' || cliOverride === 'codex' || cliOverride === 'opencode') return cliOverride;
    const first = getAvailableAgents()[0];
    if (!first) throw new Error('No editing agent CLI is installed. Install claude-code, codex, or opencode and restart the backend.');
    return first.id as CLIName;
}

export async function spawnCLIAgent(opts: SpawnOptions): Promise<CLIRunResult> {
    const cli = resolveCLI(opts.cliOverride);
    if (cli === 'claude') return spawnClaude(opts);
    if (cli === 'codex') return spawnCodex(opts);
    return spawnOpenCode(opts);
}

// ─── Claude ─────────────────────────────────────────────────────────────────

function spawnClaude(opts: SpawnOptions): Promise<CLIRunResult> {
    return new Promise((resolve, reject) => {
        const args = [
            '-p', opts.prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--model', 'sonnet',
            '--dangerously-skip-permissions',
            '--max-turns', String(opts.maxTurns),
        ];

        const proc = spawn('claude', args, {
            cwd: opts.sandboxDir,
            timeout: config.fixer.timeout,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        wireAbort(proc, opts.abortSignal, reject);

        let resultText = '';
        let costUsd = 0;
        let stderr = '';

        streamJSONL(proc.stdout, (event: any) => {
            if (event.type === 'assistant') {
                const content = event.message?.content;
                if (!Array.isArray(content)) return;
                for (const block of content) {
                    if (block.type !== 'tool_use') continue;
                    const kind = claudeToolToActivity(block.name || '');
                    const msg = opts.statusMapper({ kind });
                    if (msg) opts.sendStatus?.(msg);
                }
            }
            if (event.type === 'result') {
                resultText = event.result || '';
                costUsd = event.total_cost_usd || 0;
            }
        });

        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            if (code === 0 || code === null) {
                resolve({ text: resultText || 'Changes applied.', costUsd });
            } else {
                console.error(`[CLIRunner] claude exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
                reject(new Error(`Fixer CLI exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            console.error(`[CLIRunner] Failed to spawn claude:`, err.message);
            reject(new Error(`Failed to spawn fixer CLI "claude": ${err.message}`));
        });
    });
}

function claudeToolToActivity(name: string): CLIActivity['kind'] {
    if (name === 'Read') return 'read';
    if (name === 'Edit') return 'edit';
    if (name === 'Write') return 'write';
    if (name === 'Bash') return 'bash';
    if (name === 'Grep' || name === 'Glob') return 'search';
    return 'other';
}

// ─── Codex ──────────────────────────────────────────────────────────────────

function spawnCodex(opts: SpawnOptions): Promise<CLIRunResult> {
    return new Promise((resolve, reject) => {
        // Codex sandboxes shell commands by default; we already run inside a
        // /tmp project sandbox and need the agent to freely edit + run node,
        // so bypass. --skip-git-repo-check is required because the sandbox
        // is not a git repo.
        //
        // Pin the model to gpt-5-mini and reasoning effort to medium so a
        // user's global config.toml (often gpt-5.4 + high) doesn't make
        // every fix take 10+ minutes of hidden thinking time.
        const args = [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--dangerously-bypass-approvals-and-sandbox',
            '-c', 'model="gpt-5.4-mini"',
            '-c', 'model_reasoning_effort="medium"',
            '-C', opts.sandboxDir,
            opts.prompt,
        ];

        const proc = spawn('codex', args, {
            cwd: opts.sandboxDir,
            timeout: config.fixer.timeout,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        wireAbort(proc, opts.abortSignal, reject);

        let lastMessage = '';
        let stderr = '';

        streamJSONL(proc.stdout, (event: any) => {
            // Codex emits item.started / item.completed with a handful of item
            // kinds we care about:
            //   - command_execution: a shell command (cat, sed, bash ...)
            //   - file_change: an apply_patch edit (this is how codex edits
            //     files in practice — most of the work shows up here, NOT in
            //     command_execution)
            //   - agent_message: natural-language narration; codex emits one
            //     before each tool call describing what it's about to do, and
            //     one final summary at the end
            if (event.type !== 'item.started' && event.type !== 'item.completed') return;
            const item = event.item;
            if (!item) return;

            if (item.type === 'command_execution') {
                const kind = codexCommandToActivity(item.command || '');
                const msg = opts.statusMapper({ kind });
                if (msg) opts.sendStatus?.(msg);
                return;
            }

            if (item.type === 'file_change') {
                // Surface the file being edited if we can — otherwise a generic
                // editing status. `changes` is an array of { path, kind }.
                const first = Array.isArray(item.changes) ? item.changes[0] : null;
                const editMsg = opts.statusMapper({ kind: 'edit' }) || 'Editing files...';
                if (first?.path) {
                    const base = String(first.path).split('/').pop();
                    opts.sendStatus?.(`${editMsg.replace(/\.\.\.$/, '')}: ${base}...`);
                } else {
                    opts.sendStatus?.(editMsg);
                }
                return;
            }

            if (item.type === 'agent_message' && event.type === 'item.completed' && typeof item.text === 'string') {
                // Always track the latest message — the final one is the
                // summary returned to the chat. Additionally, if there are
                // more messages to come, surface this one as live narration
                // so the user sees what codex is doing and thinking.
                const trimmed = item.text.trim();
                if (trimmed) {
                    lastMessage = trimmed;
                    // Show just the first sentence — keeps the spinner text tight.
                    const firstSentence = trimmed.split(/(?<=[.!?])\s/)[0];
                    opts.sendStatus?.(firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence);
                }
                return;
            }
        });

        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            if (code === 0 || code === null) {
                resolve({ text: lastMessage || 'Changes applied.', costUsd: 0 });
            } else {
                console.error(`[CLIRunner] codex exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
                reject(new Error(`Fixer CLI exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            console.error(`[CLIRunner] Failed to spawn codex:`, err.message);
            reject(new Error(`Failed to spawn fixer CLI "codex": ${err.message}`));
        });
    });
}

/**
 * Map a shell command string to a rough activity. Codex runs everything
 * through /bin/sh -lc, so we peek at the leading executable to guess
 * whether it's reading / editing / searching / running bash.
 */
function codexCommandToActivity(command: string): CLIActivity['kind'] {
    // Strip the shell wrapper: `/bin/zsh -lc 'cat foo'` → `cat foo`
    const stripped = command.replace(/^\S*sh\s+-[lc]+\s+['"]?/, '').trim();
    const head = stripped.split(/\s+/)[0] || '';
    if (/^(cat|less|head|tail|bat)$/.test(head)) return 'read';
    if (/^(rg|grep|find|fd|ls|glob)$/.test(head)) return 'search';
    if (/^(apply_patch|patch|sed|awk|tee)$/.test(head)) return 'edit';
    if (head === 'bash' || stripped.includes('validate.sh')) return 'bash';
    if (/>\s*\S/.test(stripped) || /<<\s*'?EOF/.test(stripped)) return 'write';
    return 'other';
}

// ─── OpenCode ───────────────────────────────────────────────────────────────

function spawnOpenCode(opts: SpawnOptions): Promise<CLIRunResult> {
    return new Promise((resolve, reject) => {
        // opencode auto-uses the user's ~/.opencode auth. `run` is the
        // non-interactive subcommand, `--format json` emits JSONL events.
        // We deliberately don't pin a model — opencode's default (typically a
        // fast groq model like kimi-k2) is far snappier than `opencode/*`
        // hosted options, and users can swap it via their own opencode config.
        const args = [
            'run',
            '--format', 'json',
            '--dir', opts.sandboxDir,
            opts.prompt,
        ];

        const proc = spawn('opencode', args, {
            cwd: opts.sandboxDir,
            timeout: config.fixer.timeout,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        wireAbort(proc, opts.abortSignal, reject);

        let lastText = '';
        let costUsd = 0;
        let stderr = '';
        let sawError: string | null = null;

        streamJSONL(proc.stdout, (event: any) => {
            // opencode emits step_start / step_finish / tool_use / text / error
            // events. `part.tool` names the tool for tool_use; `part.text` is
            // the assistant message; `part.cost` is on step_finish.
            if (event.type === 'tool_use') {
                const tool = event.part?.tool || '';
                const status = event.part?.state?.status || '';
                // Skip errored tool calls so we don't flip back-and-forth on
                // retries; emit on completed tool runs and on pending ones
                // (the first event seen for each tool call).
                if (status === 'error') return;
                const kind = opencodeToolToActivity(tool);
                const msg = opts.statusMapper({ kind });
                if (msg) opts.sendStatus?.(msg);
                return;
            }

            if (event.type === 'text') {
                const t = event.part?.text;
                if (typeof t === 'string' && t.trim()) {
                    lastText = t.trim();
                    // Mid-stream narration → live status, keeps user informed.
                    const firstSentence = lastText.split(/(?<=[.!?])\s/)[0];
                    opts.sendStatus?.(firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence);
                }
                return;
            }

            if (event.type === 'step_finish') {
                const c = event.part?.cost;
                if (typeof c === 'number') costUsd += c;
                return;
            }

            if (event.type === 'error') {
                const m = event.error?.data?.message || event.error?.message;
                if (typeof m === 'string') sawError = m;
            }
        });

        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            if (code === 0 || code === null) {
                // opencode sometimes emits an error event mid-run but still
                // exits 0 with a partial fix; prefer the last text when present.
                if (lastText) {
                    resolve({ text: lastText, costUsd });
                } else if (sawError) {
                    reject(new Error(`opencode reported an error: ${sawError}`));
                } else {
                    resolve({ text: 'Changes applied.', costUsd });
                }
            } else {
                console.error(`[CLIRunner] opencode exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
                reject(new Error(`Fixer CLI exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            console.error(`[CLIRunner] Failed to spawn opencode:`, err.message);
            reject(new Error(`Failed to spawn fixer CLI "opencode": ${err.message}`));
        });
    });
}

function opencodeToolToActivity(name: string): CLIActivity['kind'] {
    const lower = name.toLowerCase();
    if (lower === 'read') return 'read';
    if (lower === 'edit' || lower === 'patch') return 'edit';
    if (lower === 'write') return 'write';
    if (lower === 'bash') return 'bash';
    if (lower === 'grep' || lower === 'glob' || lower === 'list') return 'search';
    return 'other';
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function wireAbort(proc: import('child_process').ChildProcess, signal: AbortSignal | undefined, reject: (e: Error) => void): void {
    if (!signal) return;
    if (signal.aborted) {
        proc.kill('SIGTERM');
        reject(new Error('Aborted'));
        return;
    }
    const onAbort = () => { proc.kill('SIGTERM'); };
    signal.addEventListener('abort', onAbort, { once: true });
    proc.on('close', () => signal.removeEventListener('abort', onAbort));
}

/**
 * Parse a stream of newline-delimited JSON objects. Holds onto the trailing
 * partial line across chunks and flushes on close.
 */
function streamJSONL(stdout: NodeJS.ReadableStream, onEvent: (event: any) => void): void {
    let buffer = '';
    stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try { onEvent(JSON.parse(line)); } catch {}
        }
    });
    stdout.on('end', () => {
        if (buffer.trim()) {
            try { onEvent(JSON.parse(buffer)); } catch {}
        }
    });
}
