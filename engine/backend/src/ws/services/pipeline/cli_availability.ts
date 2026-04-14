/**
 * cli_availability.ts — probes which fixer CLIs are installed on the host
 * at backend startup. The result is frozen for the life of the process and
 * exposed to the editor so it can offer the user only the agents that will
 * actually run.
 */

import { spawnSync } from 'child_process';

export type AgentId = 'claude' | 'codex' | 'opencode';

export interface AgentInfo {
    id: AgentId;
    /** Human-readable label the editor shows in the picker. */
    label: string;
    /** Short caption shown under the picker when this agent is selected. */
    caption: string;
    installed: boolean;
    /** Resolved binary path (e.g. `/Users/.../claude`), empty if not installed. */
    path: string;
}

const PROBES: Array<Omit<AgentInfo, 'installed' | 'path'> & { bin: string }> = [
    { id: 'claude',   bin: 'claude',   label: 'Editing Agent: Claude Code', caption: 'Edits your project files based on your prompt. Not for chatting.' },
    { id: 'codex',    bin: 'codex',    label: 'Editing Agent: Codex',       caption: 'Edits your project files based on your prompt. Not for chatting.' },
    { id: 'opencode', bin: 'opencode', label: 'Editing Agent: OpenCode',    caption: 'Edits your project files based on your prompt. Not for chatting.' },
];

let cache: AgentInfo[] | null = null;

/**
 * Probe each known CLI once. `which -a` is not portable so we just spawn the
 * binary with --version; if it starts we consider it installed. Uses a short
 * timeout so a hung CLI can't block startup.
 */
export function detectAgents(): AgentInfo[] {
    if (cache) return cache;

    const results: AgentInfo[] = [];
    for (const probe of PROBES) {
        try {
            const r = spawnSync(probe.bin, ['--version'], {
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, HOME: process.env.HOME || '/tmp' },
            });
            const ok = r.status === 0 && !r.error;
            results.push({
                id: probe.id,
                label: probe.label,
                caption: probe.caption,
                installed: ok,
                path: ok ? probe.bin : '',
            });
        } catch {
            results.push({ id: probe.id, label: probe.label, caption: probe.caption, installed: false, path: '' });
        }
    }

    cache = results;
    const installed = results.filter(a => a.installed).map(a => a.id);
    console.log(`[Agents] Detected CLI fixers: ${installed.length > 0 ? installed.join(', ') : '(none)'}`);
    return results;
}

/** Subset of detected agents that are actually installed. */
export function getAvailableAgents(): AgentInfo[] {
    return detectAgents().filter(a => a.installed);
}

/** Whether a given agent id is installed on this host. */
export function isAgentAvailable(id: string): id is AgentId {
    return getAvailableAgents().some(a => a.id === id);
}
