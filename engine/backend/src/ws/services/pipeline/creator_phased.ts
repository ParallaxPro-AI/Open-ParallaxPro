/**
 * creator_phased.ts — Approach B: split CREATE_GAME into 5 claude -p
 * invocations, each with a narrow CLAUDE.md tailored to its phase.
 *
 * Goals:
 *   1. Shrink per-turn prefix (phase CLAUDE.md is 2-4K tokens vs
 *      monolithic 11.5K). cache_read cost scales with prefix size.
 *   2. Reuse cache across phases — CLI baseline + sandbox files cache
 *      once and cache_read on each subsequent phase's first call.
 *   3. Fewer total turns because each phase is narrowly focused.
 *
 * Flow:
 *   1. Build sandbox once (same layout as cli_creator.createSandbox).
 *   2. For each of 5 phases:
 *      a. Rewrite sandbox/CLAUDE.md = core.md + phaseN.md
 *      b. Spawn claude -p with phase-specific prompt
 *      c. Wait for process exit; check handoff/phaseN_complete sentinel
 *   3. Snapshot project/ into CreatorResult — same shape as runCreator.
 *
 * Feature-flagged via config.useCreatorPhased. When off (default), the
 * caller falls through to the existing runCreator. No changes to the
 * single-agent path.
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { config } from '../../../config.js';
import { wrapSpawn } from './docker_sandbox.js';
import type { ProjectFiles } from './project_files.js';

const __dirname_cp = path.dirname(fileURLToPath(import.meta.url));
const CTX_DIR = path.join(__dirname_cp, 'creator_context');

// ─── Phase definitions ───────────────────────────────────────────────────

type PhaseId = 'architect' | 'entities_worlds' | 'systems_flow' | 'ui_scripts' | 'validate_fix';

interface PhaseConfig {
    id: PhaseId;
    num: 1 | 2 | 3 | 4 | 5;
    deltaFile: string;        // phase-specific CLAUDE.md addendum
    prompt: string;           // -p value sent to claude
    maxTurns: number;
    sentinel: string;         // relative path to completion file (agent writes it)
    mustHaveAfter: string[];  // files that MUST exist after the phase — hard requirement
    /** Tools the phase is allowed to use. Phase 1 is read+plan only (no Write). */
    tools: string[];
}

const PHASES: PhaseConfig[] = [
    {
        id: 'architect', num: 1,
        deltaFile: 'phase1_architect.md',
        prompt: [
            'PHASE 1 of 5 — ARCHITECT.',
            'Read TASK.md and reference/game_templates/INDEX.md.',
            'Skim 2-3 candidate templates at most. Decide template + atmosphere + entity/system/behavior lists.',
            'Write handoff/spec.json matching the schema in your CLAUDE.md.',
            'Write handoff/phase1_complete (empty). Do NOT write anything in project/. Exit.',
        ].join(' '),
        maxTurns: 15,
        sentinel: 'handoff/phase1_complete',
        mustHaveAfter: ['handoff/spec.json'],
        tools: ['Bash', 'Read', 'Write', 'Glob', 'Grep'],
    },
    {
        id: 'entities_worlds', num: 2,
        deltaFile: 'phase2_entities_worlds.md',
        prompt: [
            'PHASE 2 of 5 — ENTITIES + WORLDS.',
            'Read handoff/spec.json. Read the picked template with bash library.sh show templates/<id>.',
            'Use search_assets.sh for every asset path. Fetch library behaviors with library.sh show — redirect to project/behaviors/ for verbatim copies.',
            'Write project/02_entities.json and project/03_worlds.json.',
            'When done, write handoff/phase2_complete (empty) and exit.',
        ].join(' '),
        maxTurns: 35,
        sentinel: 'handoff/phase2_complete',
        mustHaveAfter: ['project/02_entities.json', 'project/03_worlds.json'],
        tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    },
    {
        id: 'systems_flow', num: 3,
        deltaFile: 'phase3_systems_flow.md',
        prompt: [
            'PHASE 3 of 5 — SYSTEMS + FLOW.',
            'Read handoff/spec.json. Read project/02_entities.json and project/03_worlds.json.',
            'Reference the same template via bash library.sh show templates/<id>.',
            'Write project/04_systems.json and project/01_flow.json.',
            'Event declarations go in project/systems/event_definitions.ts (add, do not rename existing events).',
            'When done, write handoff/phase3_complete (empty) and exit.',
        ].join(' '),
        maxTurns: 30,
        sentinel: 'handoff/phase3_complete',
        mustHaveAfter: ['project/04_systems.json', 'project/01_flow.json'],
        tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    },
    {
        id: 'ui_scripts', num: 4,
        deltaFile: 'phase4_ui_scripts.md',
        prompt: [
            'PHASE 4 of 5 — UI + SCRIPTS.',
            'Read handoff/spec.json and all four project JSONs.',
            'Inventory what is referenced but not yet present (active_behaviors, active_systems, show_ui panels).',
            'Fetch library UI panels + behaviors/systems with library.sh show (or copy verbatim via redirect).',
            'Write or pin every referenced .html and .ts.',
            'You may patch project/01_flow.json to fix UI button name mismatches (only for that purpose).',
            'Run bash validate.sh. Fix errors. When validate passes OR you have converged, write handoff/phase4_complete and exit.',
        ].join(' '),
        maxTurns: 50,
        sentinel: 'handoff/phase4_complete',
        mustHaveAfter: [],  // validator enforces
        tools: ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'],
    },
    {
        id: 'validate_fix', num: 5,
        deltaFile: 'phase5_validate_fix.md',
        prompt: [
            'PHASE 5 of 5 — VALIDATE + FIX.',
            'Run bash validate.sh. If All checks passed, write handoff/phase5_complete and exit.',
            'Otherwise, map each failure to a class in your CLAUDE.md, apply targeted Edit fixes, re-run validate.',
            'Budget: 5 rounds. If failures persist past 5 rounds, write handoff/phase5_failed and exit.',
        ].join(' '),
        maxTurns: 20,
        sentinel: 'handoff/phase5_complete',
        mustHaveAfter: [],
        tools: ['Bash', 'Read', 'Edit', 'Write', 'Glob', 'Grep'],
    },
];

// ─── Phase runner ────────────────────────────────────────────────────────

interface RunPhasedInput {
    sandboxDir: string;
    claudeModel: string;
    abortSignal?: AbortSignal;
    sendStatus?: (msg: string) => void;
    /** called back once per phase with per-phase cost so caller can stash telemetry */
    onPhaseDone?: (phase: PhaseId, costUsd: number, success: boolean, turns: number) => void;
}

export interface RunPhasedResult {
    allPhasesSucceeded: boolean;
    totalCostUsd: number;
    perPhase: Array<{ phase: PhaseId; costUsd: number; turns: number; success: boolean; failureReason?: string }>;
    /** sessionCapturePath of the final (phase 5) run — used for screenshot/artifact linking */
    lastSessionCapturePath: string | null;
}

/**
 * Drive the phased pipeline. Sandbox is expected to be fully set up
 * (CLAUDE.md core+delta written per-phase by this function, but the
 * templates, library.sh, validate.sh, search_assets.sh, TASK.md all
 * pre-present).
 */
export async function runCreatorPhased(input: RunPhasedInput): Promise<RunPhasedResult> {
    const { sandboxDir, claudeModel, abortSignal, sendStatus, onPhaseDone } = input;
    const coreDoc = fs.readFileSync(path.join(CTX_DIR, 'core.md'), 'utf-8');
    const handoffDir = path.join(sandboxDir, 'handoff');
    fs.mkdirSync(handoffDir, { recursive: true });

    const perPhase: RunPhasedResult['perPhase'] = [];
    let totalCost = 0;
    let lastSessionCapturePath: string | null = null;
    let allOk = true;

    for (const phase of PHASES) {
        if (abortSignal?.aborted) break;
        sendStatus?.(`[phase ${phase.num}/5 · ${phase.id}] starting…`);

        // Per-phase CLAUDE.md = core + delta. Written fresh each phase so
        // the claude -p on next iteration reads the right one.
        const delta = fs.readFileSync(path.join(CTX_DIR, phase.deltaFile), 'utf-8');
        const combined = `${coreDoc}\n\n${delta}`;
        fs.writeFileSync(path.join(sandboxDir, 'CLAUDE.md'), combined);
        fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), combined);

        const { costUsd, turns, success, failureReason, sessionCapturePath } = await runSinglePhase({
            sandboxDir,
            claudeModel,
            phase,
            abortSignal,
        });

        totalCost += costUsd;
        if (sessionCapturePath) lastSessionCapturePath = sessionCapturePath;

        const phaseOk = success && sentinelExists(sandboxDir, phase.sentinel)
            && phase.mustHaveAfter.every(f => fs.existsSync(path.join(sandboxDir, f)));

        perPhase.push({
            phase: phase.id,
            costUsd,
            turns,
            success: phaseOk,
            failureReason: phaseOk ? undefined : (failureReason || 'sentinel/required-files missing'),
        });
        onPhaseDone?.(phase.id, costUsd, phaseOk, turns);
        sendStatus?.(`[phase ${phase.num}/5 · ${phase.id}] ${phaseOk ? 'done' : 'failed'} · $${costUsd.toFixed(3)} · ${turns} turns`);

        if (!phaseOk) {
            allOk = false;
            // Later phases may still partially work even after an early
            // phase fails — e.g. validate phase can clean up whatever
            // made it into project/. But stopping early is safer as an
            // MVP until we understand failure modes.
            break;
        }
    }

    return { allPhasesSucceeded: allOk, totalCostUsd: totalCost, perPhase, lastSessionCapturePath };
}

// ─── Single-phase spawn ──────────────────────────────────────────────────

interface SinglePhaseResult {
    costUsd: number;
    turns: number;
    success: boolean;
    failureReason?: string;
    sessionCapturePath?: string | null;
}

function runSinglePhase(args: {
    sandboxDir: string;
    claudeModel: string;
    phase: PhaseConfig;
    abortSignal?: AbortSignal;
}): Promise<SinglePhaseResult> {
    return new Promise((resolve) => {
        const { sandboxDir, claudeModel, phase, abortSignal } = args;

        const spawnArgs = [
            '-p', phase.prompt,
            '--output-format', 'stream-json',
            '--verbose',
            '--model', claudeModel,
            '--dangerously-skip-permissions',
            '--max-turns', String(phase.maxTurns),
            '--tools', ...phase.tools,
            '--strict-mcp-config',
        ];
        const { command, args: wrapped } = wrapSpawn('claude', 'claude', spawnArgs, sandboxDir);
        const proc = spawn(command, wrapped, {
            cwd: sandboxDir,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, HOME: process.env.HOME || '/tmp' },
        });

        if (abortSignal) {
            const kill = () => proc.kill('SIGTERM');
            if (abortSignal.aborted) kill();
            else abortSignal.addEventListener('abort', kill, { once: true });
        }

        let costUsd = 0;
        let turns = 0;
        let sessionCapturePath: string | null = null;
        let buffer = '';
        let stderr = '';

        proc.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString();
            let idx;
            while ((idx = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 1);
                if (!line.trim()) continue;
                try {
                    const evt = JSON.parse(line);
                    if (evt.type === 'result') {
                        if (typeof evt.total_cost_usd === 'number') costUsd = evt.total_cost_usd;
                        if (typeof evt.num_turns === 'number') turns = evt.num_turns;
                    }
                    // Session capture path may appear on a system event's cwd
                    // field or a dedicated capture marker; for now derive
                    // nothing explicit here — the orchestrator doesn't need
                    // per-phase capture paths for the final CreatorResult,
                    // the sandbox is sufficient.
                } catch { /* non-JSON stream line, ignore */ }
            }
        });
        proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });

        proc.on('close', (code) => {
            resolve({
                costUsd,
                turns,
                success: code === 0,
                failureReason: code !== 0 ? `claude exited ${code}: ${stderr.slice(-200)}` : undefined,
                sessionCapturePath,
            });
        });
        proc.on('error', (err) => {
            resolve({ costUsd: 0, turns: 0, success: false, failureReason: err.message });
        });
    });
}

function sentinelExists(sandboxDir: string, rel: string): boolean {
    return fs.existsSync(path.join(sandboxDir, rel));
}

/** Snapshot project/ into the ProjectFiles shape runCreator returns. */
export function snapshotProjectFiles(sandboxDir: string): ProjectFiles | null {
    const projectDir = path.join(sandboxDir, 'project');
    if (!fs.existsSync(projectDir)) return null;
    const out: Record<string, string> = {};
    const walk = (dir: string, rel: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            const rpath = rel ? path.posix.join(rel, entry.name) : entry.name;
            if (entry.isDirectory()) walk(full, rpath);
            else {
                try { out[rpath] = fs.readFileSync(full, 'utf-8'); } catch {}
            }
        }
    };
    walk(projectDir, '');
    return out as ProjectFiles;
}
