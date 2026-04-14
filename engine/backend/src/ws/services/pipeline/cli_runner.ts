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
     * Override which CLI to use for this one call. Accepts 'claude' | 'codex'.
     * When unset, falls back to the first CLI detected at startup
     * (claude preferred, codex second).
     */
    cliOverride?: string;
}

/**
 * Pick the CLI for this call. Preference order:
 *   1. Explicit `cliOverride` if set (per-message pick / per-project setting).
 *   2. First agent detected at startup — `PROBES` orders claude before codex,
 *      so claude wins whenever it's installed.
 * Throws if nothing is installed.
 */
function resolveCLI(cliOverride?: string): 'claude' | 'codex' {
    if (cliOverride === 'claude' || cliOverride === 'codex') return cliOverride;
    const first = getAvailableAgents()[0];
    if (!first) throw new Error('No editing agent CLI is installed. Install claude-code or codex and restart the backend.');
    return first.id;
}

export async function spawnCLIAgent(opts: SpawnOptions): Promise<CLIRunResult> {
    const cli = resolveCLI(opts.cliOverride);
    if (cli === 'claude') return spawnClaude(opts);
    return spawnCodex(opts);
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
            stdio: ['pipe', 'pipe', 'pipe'],
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
        const args = [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--dangerously-bypass-approvals-and-sandbox',
            '-C', opts.sandboxDir,
            opts.prompt,
        ];

        const proc = spawn('codex', args, {
            cwd: opts.sandboxDir,
            timeout: config.fixer.timeout,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        wireAbort(proc, opts.abortSignal, reject);

        let lastMessage = '';
        let stderr = '';

        streamJSONL(proc.stdout, (event: any) => {
            // Codex emits item.started / item.completed. Tool-style activity
            // is `command_execution`; final output comes as `agent_message`.
            if (event.type === 'item.started' || event.type === 'item.completed') {
                const item = event.item;
                if (!item) return;
                if (item.type === 'command_execution') {
                    const kind = codexCommandToActivity(item.command || '');
                    const msg = opts.statusMapper({ kind });
                    if (msg) opts.sendStatus?.(msg);
                } else if (item.type === 'agent_message' && event.type === 'item.completed') {
                    if (typeof item.text === 'string' && item.text.trim()) {
                        lastMessage = item.text;
                    }
                }
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
