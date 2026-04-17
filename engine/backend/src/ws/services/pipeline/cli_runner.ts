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
import * as fs from 'fs';
import * as path from 'path';
import { config } from '../../../config.js';
import { getAvailableAgents } from './cli_availability.js';
import { wrapSpawn } from './docker_sandbox.js';

// ─── Concurrency gate ───────────────────────────────────────────────────────
//
// Per-CLI in-flight caps, shared across `runFixer` and `runCreator`. Callers
// await acquireCLISlot({ cliOverride, sendStatus, jobId }) before spawning
// and must call releaseCLISlot(cliOverride) in a finally block — critically,
// both calls must use the same cliOverride value so the same bucket is
// incremented and then decremented.
//
// opencode gets a much higher cap because it's usually routed at a
// hosted-provider API (Groq, Anthropic, etc.) — lots of cheap, fast
// completions. claude/codex/copilot run heavier reasoning-backed CLIs
// that each consume real CPU/RAM on the host, so 8 concurrent is plenty.

const MAX_PER_CLI: Record<CLIName, number> = {
    claude: 8,
    codex: 8,
    opencode: 64,
    copilot: 8,
};

const activeCountByCLI: Record<CLIName, number> = { claude: 0, codex: 0, opencode: 0, copilot: 0 };
// Queue entries carry the caller's jobId so consumers (e.g. generation_jobs)
// can look up their position while waiting. A stable jobId makes this a
// one-liner; without it we'd need to thread the same Promise reference
// through the caller just to find "am I still queued?".
interface QueueEntry { jobId: string; resolve: () => void; }
const waitQueueByCLI: Record<CLIName, QueueEntry[]> = { claude: [], codex: [], opencode: [], copilot: [] };

export interface AcquireOpts {
    /** Caller-provided identifier used for queue position lookups. Anonymous
     *  callers (fixers, legacy runQaCreator removal, etc.) can pass a random
     *  uuid — anything unique will do. */
    jobId?: string;
    cliOverride?: string;
    sendStatus?: (msg: string) => void;
}

export function acquireCLISlot(opts: AcquireOpts = {}): Promise<void> {
    const { jobId, cliOverride, sendStatus } = opts;
    const cli = resolveCLI(cliOverride);
    const cap = MAX_PER_CLI[cli];
    if (activeCountByCLI[cli] < cap) {
        activeCountByCLI[cli]++;
        return Promise.resolve();
    }
    const queue = waitQueueByCLI[cli];
    sendStatus?.(`Queued — ${queue.length + 1} in line for ${cli}, waiting for a slot...`);
    return new Promise<void>((resolve) => {
        queue.push({ jobId: jobId || '', resolve: () => { activeCountByCLI[cli]++; resolve(); } });
    });
}

/**
 * Current 1-indexed queue position for a given jobId + cli, or null if the
 * job is not currently queued (already running, or already released).
 * Callers poll this while the slot-acquire promise is pending to keep the
 * user-facing status fresh (e.g. "Queued — position 2 of 3").
 */
export function getQueuePosition(cliOverride: string | undefined, jobId: string): { position: number; total: number; cli: CLIName } | null {
    const cli = resolveCLI(cliOverride);
    const queue = waitQueueByCLI[cli];
    const idx = queue.findIndex(e => e.jobId === jobId);
    if (idx < 0) return null;
    return { position: idx + 1, total: queue.length, cli };
}

/** Snapshot of active/queued CLI slots for admin dashboards. */
export function getCLISlotStats(): Record<string, { active: number; queued: number; max: number }> {
    const result: Record<string, { active: number; queued: number; max: number }> = {};
    for (const cli of Object.keys(MAX_PER_CLI) as CLIName[]) {
        result[cli] = { active: activeCountByCLI[cli], queued: waitQueueByCLI[cli].length, max: MAX_PER_CLI[cli] };
    }
    return result;
}

export function releaseCLISlot(cliOverride?: string): void {
    const cli = resolveCLI(cliOverride);
    activeCountByCLI[cli]--;
    const next = waitQueueByCLI[cli].shift();
    if (next) next.resolve();
}

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
     * 'opencode' | 'copilot'. When unset, falls back to the first CLI detected
     * at startup (probe order: claude → codex → opencode → copilot).
     */
    cliOverride?: string;
    /**
     * Wall-clock cap in ms. Defaults to `config.fixer.timeout` (20 min) —
     * fine for fixer runs, but cli_creator bumps this to 45 min because
     * CREATE_GAME is expected to take 20–30 min and ambitious prompts
     * push higher. After this elapses child_process sends SIGTERM (then
     * SIGKILL) to the CLI agent.
     */
    timeout?: number;
}

type CLIName = 'claude' | 'codex' | 'opencode' | 'copilot';

const VALID_CLI_NAMES: ReadonlySet<CLIName> = new Set(['claude', 'codex', 'opencode', 'copilot']);

/**
 * Pick the CLI for this call. Strict about overrides — when the caller
 * asked for a specific CLI we must use exactly that one or fail loudly:
 *
 *   - `cliOverride` is an unknown string → throw (prevents silent fallback
 *     when a stale/typo'd value leaks in from projectConfig).
 *   - `cliOverride` is a known CLI but isn't installed on this host → throw
 *     with a clear "X is not installed" error so the user picks another,
 *     rather than quietly getting Claude when they chose Codex.
 *   - `cliOverride` unset → fall back to the first detected CLI (PROBES
 *     order: claude → codex → opencode → copilot).
 *   - Nothing installed → throw.
 */
export function resolveCLI(cliOverride?: string): CLIName {
    if (cliOverride) {
        if (!VALID_CLI_NAMES.has(cliOverride as CLIName)) {
            throw new Error(`Unknown editing agent "${cliOverride}". Valid values: ${Array.from(VALID_CLI_NAMES).join(', ')}.`);
        }
        const installed = getAvailableAgents().some(a => a.id === cliOverride);
        if (!installed) {
            throw new Error(`Editing agent "${cliOverride}" is not installed on this server. Pick a different agent or install the CLI and restart the backend.`);
        }
        return cliOverride as CLIName;
    }
    const first = getAvailableAgents()[0];
    if (!first) throw new Error('No editing agent CLI is installed. Install claude-code, codex, opencode, or copilot and restart the backend.');
    return first.id as CLIName;
}

export async function spawnCLIAgent(opts: SpawnOptions): Promise<CLIRunResult> {
    const cli = resolveCLI(opts.cliOverride);
    const startedAt = Date.now();
    let result: CLIRunResult;
    switch (cli) {
        case 'claude':   result = await spawnClaude(opts);   break;
        case 'codex':    result = await spawnCodex(opts);    break;
        case 'opencode': result = await spawnOpenCode(opts); break;
        case 'copilot':  result = await spawnCopilot(opts);  break;
        default: {
            // Exhaustiveness check — the assignment forces a compile error if
            // a new CLIName is added but no spawn case is wired here, instead
            // of silently falling through to a default.
            const _exhaustive: never = cli;
            throw new Error(`No spawn implementation for CLI "${_exhaustive}".`);
        }
    }
    // If the user pressed Stop mid-run, the CLI was killed before emitting
    // its authoritative cost event (or codex/copilot never emit one at all),
    // so most runners resolve with costUsd=0. Replace with a flat estimate:
    // 20k tokens/minute against wall-clock runtime. At the usage plugin's
    // $1 = 500k tokens conversion that's $0.04/min. Applied uniformly across
    // all four CLIs so aborted runs always leave a trail in the usage
    // dashboard — better a rough number than no number.
    if (opts.abortSignal?.aborted) {
        result.costUsd = 0.04 * ((Date.now() - startedAt) / 60_000);
    }
    return result;
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

        const { command, args: spawnArgs } = wrapSpawn('claude', 'claude', args, opts.sandboxDir);
        const proc = spawn(command, spawnArgs, {
            cwd: opts.sandboxDir,
            timeout: opts.timeout ?? config.fixer.timeout,
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
        // Pin model to gpt-5.4 and reasoning effort to medium so a user's
        // global config.toml (often high effort) doesn't make every fix take
        // 10+ minutes of hidden thinking time.
        const args = [
            'exec',
            '--json',
            '--skip-git-repo-check',
            '--dangerously-bypass-approvals-and-sandbox',
            '-c', 'model="gpt-5.4"',
            '-c', 'model_reasoning_effort="medium"',
            '-C', opts.sandboxDir,
            opts.prompt,
        ];

        const { command, args: spawnArgs } = wrapSpawn('codex', 'codex', args, opts.sandboxDir);
        const proc = spawn(command, spawnArgs, {
            cwd: opts.sandboxDir,
            timeout: opts.timeout ?? config.fixer.timeout,
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
        //
        // Drop an opencode.json in the sandbox that bumps the default `build`
        // agent's step budget to 20. Default is ~15, which weaker models (e.g.
        // gpt-oss-20b) exhaust while still planning — see projectId de549996:
        // the agent spent 16 steps exploring and writing zero files before
        // hitting the cap. 20 gives a modest extra headroom; relying on more
        // budget to paper over weak models isn't the fix — the real lever is
        // trimming exploration via AGENTS.md / template pre-seeding.
        try {
            fs.writeFileSync(
                path.join(opts.sandboxDir, 'opencode.json'),
                JSON.stringify({ agent: { build: { steps: 20 } } }),
            );
        } catch (e: any) {
            console.warn(`[CLIRunner] Failed to write opencode.json: ${e.message}`);
        }

        const args = [
            'run',
            '--format', 'json',
            '--dir', opts.sandboxDir,
            opts.prompt,
        ];

        const { command, args: spawnArgs } = wrapSpawn('opencode', 'opencode', args, opts.sandboxDir);
        const proc = spawn(command, spawnArgs, {
            cwd: opts.sandboxDir,
            timeout: opts.timeout ?? config.fixer.timeout,
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

// ─── Copilot ────────────────────────────────────────────────────────────────

function spawnCopilot(opts: SpawnOptions): Promise<CLIRunResult> {
    return new Promise((resolve, reject) => {
        // GitHub Copilot CLI: -p runs a single prompt non-interactively,
        // --output-format json emits JSONL events. `--allow-all` is the
        // equivalent of claude's --dangerously-skip-permissions (auto-allow
        // every tool/path/URL). `--no-ask-user` prevents the agent from
        // blocking on interactive questions. `--add-dir` grants file access
        // to our sandbox; without it copilot refuses to read outside the
        // config dir. `--log-level none` keeps the stdout stream clean.
        // `--no-auto-update` avoids a silent npm update in the middle of a
        // backend-served request.
        const args = [
            '-p', opts.prompt,
            '--output-format', 'json',
            '--allow-all',
            '--no-ask-user',
            '--no-auto-update',
            '--log-level', 'none',
            '--add-dir', opts.sandboxDir,
        ];

        const { command, args: spawnArgs } = wrapSpawn('copilot', 'copilot', args, opts.sandboxDir);
        const proc = spawn(command, spawnArgs, {
            cwd: opts.sandboxDir,
            timeout: opts.timeout ?? config.fixer.timeout,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        wireAbort(proc, opts.abortSignal, reject);

        let lastFinalText = '';
        let stderr = '';

        streamJSONL(proc.stdout, (event: any) => {
            // tool.execution_start fires once per tool call with { toolName,
            // arguments }. We map the tool name to an activity for status.
            if (event.type === 'tool.execution_start') {
                const tool = event.data?.toolName || '';
                // `report_intent` is copilot's "I'm about to do X" narration
                // tool — fires before each real action. Skip it so the status
                // line doesn't flicker to a generic message before every
                // actual read/edit.
                if (tool === 'report_intent') return;
                const kind = copilotToolToActivity(tool);
                const msg = opts.statusMapper({ kind });
                if (msg) opts.sendStatus?.(msg);
                return;
            }

            // assistant.message with phase 'final_answer' and no pending
            // toolRequests is the last reply to the user — capture its
            // content as the summary. Intermediate commentary messages
            // (phase 'commentary') describe what copilot is about to do;
            // surface them as live status.
            if (event.type === 'assistant.message') {
                const d = event.data || {};
                const content: string = typeof d.content === 'string' ? d.content.trim() : '';
                if (!content) return;
                const hasPendingTools = Array.isArray(d.toolRequests) && d.toolRequests.length > 0;
                if (d.phase === 'final_answer' && !hasPendingTools) {
                    lastFinalText = content;
                    return;
                }
                if (d.phase === 'commentary') {
                    const firstSentence = content.split(/(?<=[.!?])\s/)[0];
                    opts.sendStatus?.(firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence);
                }
            }
        });

        proc.stderr.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            if (code === 0 || code === null) {
                // Copilot doesn't report a dollar cost (only premiumRequests
                // in the final `result` event), so costUsd stays 0.
                resolve({ text: lastFinalText || 'Changes applied.', costUsd: 0 });
            } else {
                console.error(`[CLIRunner] copilot exited with code ${code}. stderr: ${stderr.slice(0, 500)}`);
                reject(new Error(`Fixer CLI exited with code ${code}`));
            }
        });

        proc.on('error', (err) => {
            console.error(`[CLIRunner] Failed to spawn copilot:`, err.message);
            reject(new Error(`Failed to spawn fixer CLI "copilot": ${err.message}`));
        });
    });
}

function copilotToolToActivity(name: string): CLIActivity['kind'] {
    const lower = name.toLowerCase();
    // Observed copilot tool names: `view` (read), `str_replace_editor` /
    // `edit` (edit), `create` (write), `bash` (shell), `grep` / `glob`
    // (search). Unknown → 'other' so the mapper falls through to a generic
    // status.
    if (lower === 'view' || lower === 'read') return 'read';
    if (lower === 'edit' || lower === 'str_replace_editor' || lower === 'patch') return 'edit';
    if (lower === 'create' || lower === 'write') return 'write';
    if (lower === 'bash' || lower === 'shell' || lower === 'run') return 'bash';
    if (lower === 'grep' || lower === 'glob' || lower === 'search' || lower === 'list' || lower === 'find') return 'search';
    return 'other';
}

// ─── Shared helpers ─────────────────────────────────────────────────────────

function wireAbort(proc: import('child_process').ChildProcess, signal: AbortSignal | undefined, reject: (e: Error) => void): void {
    if (!signal) return;
    // SIGTERM → 5s grace window → SIGKILL. Some CLI agents ignore SIGTERM
    // outright (opencode has been observed to) and some docker-wrapped
    // processes drop the signal before it reaches the container's PID 1
    // if run without --init. The escalation guarantees the process dies
    // even when the polite signal is ignored.
    const killEscalate = () => {
        try { proc.kill('SIGTERM'); } catch {}
        setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 5000);
    };
    if (signal.aborted) {
        killEscalate();
        reject(new Error('Aborted'));
        return;
    }
    const onAbort = () => { killEscalate(); };
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
