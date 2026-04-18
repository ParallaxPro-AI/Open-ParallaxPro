/**
 * template_health.ts — boot-time quality check for every shipped template.
 *
 * Runs the same checks the CLI sandbox's validate.sh runs on
 * CREATE_GAME / FIX_GAME output, so a shipped template that would fail
 * CLI validation can't slip past us either. Every check is reused from
 * `sandbox_validate.ts` (the authoritative spec); the bash/node strings
 * in that file are the CLI-side mirror copies of the exact same logic.
 *
 * Four stages per template, short-circuit on the first hard error class:
 *
 *   1. json     — JSON.parse on the 4 template files.
 *   2. syntax   — `new Function(...)` on every .ts in behaviors/systems/
 *                 scripts/. Catches parse-level typos.
 *   3. smoke    — instantiate each class, run onStart + 60 onUpdate ticks
 *                 against stub runtimes. Catches null-derefs that only
 *                 bite at runtime.
 *   4. assemble — the real `assembleGame(folder)` — structural validator
 *                 (event names, active_behaviors referential integrity,
 *                 UI button wiring, required `start` fields).
 *
 * A single template failure NEVER crashes boot — one bad template
 * shouldn't DoS the whole service. Results are cached for the admin
 * dashboard banner.
 */

import {
    checkTemplateJSON,
    checkScriptSyntax,
    runHeadlessSmoke,
} from './sandbox_validate.js';

export type HealthStage = 'json' | 'syntax' | 'smoke' | 'assemble';

export interface TemplateHealthFailure {
    templateId: string;
    stage: HealthStage;
    error: string;
}

export interface TemplateHealthResult {
    totalCount: number;
    passedCount: number;
    failedCount: number;
    failures: TemplateHealthFailure[];
    lastRunAt: string;
    lastRunAtEpochMs: number;
}

let _lastResult: TemplateHealthResult | null = null;

export function getTemplateHealthResults(): TemplateHealthResult | null {
    return _lastResult;
}

export function runTemplateHealthChecks(
    catalog: Array<{ id: string }>,
    loadTemplate: (id: string) => { _folderPath?: string } | null,
    assembleGame: (folderPath: string) => void,
): TemplateHealthResult {
    const failures: TemplateHealthFailure[] = [];
    for (const t of catalog) {
        const template = loadTemplate(t.id);
        if (!template?._folderPath) {
            failures.push({ templateId: t.id, stage: 'json', error: 'template folder path missing' });
            continue;
        }
        const folder = template._folderPath;

        // Stage 1: JSON parse. If any of the 4 is malformed, later stages
        // produce noisy cascade errors — stop at the first bad stage.
        const jsonErrs = checkTemplateJSON(folder);
        if (jsonErrs.length > 0) {
            for (const e of jsonErrs) failures.push({ templateId: t.id, stage: 'json', error: e });
            continue;
        }

        // Stage 2: script syntax.
        const syntaxErrs = checkScriptSyntax(folder);
        if (syntaxErrs.length > 0) {
            for (const e of syntaxErrs) failures.push({ templateId: t.id, stage: 'syntax', error: e });
            continue;
        }

        // Stage 3: headless smoke. We keep going even if this errors —
        // smoke failures are often stubs being slightly off, so we still
        // want stage 4 to run and report.
        const smokeErrs = runHeadlessSmoke(folder);
        for (const e of smokeErrs) failures.push({ templateId: t.id, stage: 'smoke', error: e });

        // Stage 4: strict assembler.
        try {
            assembleGame(folder);
        } catch (e: any) {
            failures.push({ templateId: t.id, stage: 'assemble', error: e?.message || String(e) });
        }
    }

    // A template counts as failed if it contributed any failure row.
    const failedIds = new Set(failures.map(f => f.templateId));
    const now = Date.now();
    _lastResult = {
        totalCount: catalog.length,
        passedCount: catalog.length - failedIds.size,
        failedCount: failedIds.size,
        failures,
        lastRunAt: new Date(now).toISOString(),
        lastRunAtEpochMs: now,
    };
    return _lastResult;
}
