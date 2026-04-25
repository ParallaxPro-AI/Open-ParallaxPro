#!/usr/bin/env node
/**
 * Script-side API smoke test.
 *
 * The script-facing wrappers (entity.transform, scene.events, scene.input,
 * scene.audio) are hand-curated objects in script_scene_builder.ts that
 * re-expose engine methods. When we add a new helper to the underlying
 * engine class (e.g. TransformComponent.faceDirection in iteration 6),
 * we must also add a mirror on the wrapper or scripts crash with
 * `is not a function`. The regression baseline doesn't catch this
 * because the curated games don't call the new method, and the
 * coverage harness targets specific invariants — neither exercises
 * "every method we promise scripts is reachable."
 *
 * This smoke loads the clean Marine Drive fixture, spins up the
 * headless runtime, grabs the player entity's transform wrapper, and
 * asserts the expected method surface is present and callable. If a
 * future change drops a method or breaks a signature, this smoke
 * fires before the dashboard regression badge would even know to
 * complain.
 *
 * Usage: npm run api-smoke
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runPlaytest, Playtest, loadGame, Runtime } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLEAN_SRC = path.resolve(REPO_ROOT, 'engine/backend/cli_sandbox_archives/2026-04-22T20-48-51-996Z_success_research/project');

interface Failure { area: string; reason: string; }

async function main(): Promise<void> {
    const failures: Failure[] = [];

    // Spin up the same runtime the regression suite uses, but only
    // boot — we don't need to tick.
    const files = loadGame(CLEAN_SRC);
    const runtime = new Runtime(files);
    await runtime.boot();
    const playtest = new Playtest(runtime);

    // Find any entity that has a script — we need access to the
    // scriptTransform wrapper, which scripts get via `this.entity.transform`.
    // The wrapper is built per-entity inside script_scene_builder's
    // makeScriptEntity, so the only way to introspect it is to peek at
    // an instantiated script's `entity.transform`.
    playtest.activateAllBehaviors();
    const scriptInstances: any[] = (runtime as any).scriptSystem?.instances ?? [];
    const sample = scriptInstances.find(inst => inst?.script?.entity?.transform);
    if (!sample) {
        failures.push({ area: 'setup', reason: 'no script instance with a transform — clean fixture changed?' });
    } else {
        const t = sample.script.entity.transform;
        // Minimum API surface every behaviour relies on. If any of these
        // disappears or stops being callable, scripts in real games
        // crash on tick.
        const expected: Array<{ name: string; call: () => void }> = [
            { name: 'setPosition',     call: () => t.setPosition(0, 0, 0) },
            { name: 'setRotationEuler',call: () => t.setRotationEuler(0, 0, 0) },
            { name: 'getRotationEuler',call: () => t.getRotationEuler() },
            { name: 'getEulerAngles',  call: () => t.getEulerAngles() },
            { name: 'lookAt',          call: () => t.lookAt(0, 0, 0) },
            { name: 'faceDirection',   call: () => t.faceDirection(1, 0) },
        ];
        for (const m of expected) {
            const fn = (t as any)[m.name];
            if (typeof fn !== 'function') {
                failures.push({ area: `transform.${m.name}`, reason: 'method missing on scriptTransform wrapper' });
                continue;
            }
            try { m.call(); }
            catch (e: any) {
                failures.push({ area: `transform.${m.name}`, reason: `threw: ${e?.message ?? e}` });
            }
        }
        // Direction-vector getters are properties, not methods, but
        // scripts read them as `this.entity.transform.forward`.
        for (const prop of ['forward', 'right', 'up'] as const) {
            const v = (t as any)[prop];
            if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
                failures.push({ area: `transform.${prop}`, reason: 'property missing or not a Vec3-like' });
            }
        }
    }

    // Scene API surface.
    const sceneSample = scriptInstances.find(inst => inst?.script?.scene);
    if (sceneSample) {
        const s = sceneSample.script.scene;
        const sceneExpected = ['setPosition', 'setVelocity', 'setRotationEuler', 'spawnEntity', 'findEntityByName', 'destroyEntity'];
        for (const name of sceneExpected) {
            if (typeof (s as any)[name] !== 'function') {
                failures.push({ area: `scene.${name}`, reason: 'method missing on script scene wrapper' });
            }
        }
        if (!s.events?.game?.emit || !s.events?.game?.on || !s.events?.ui?.emit || !s.events?.ui?.on) {
            failures.push({ area: 'scene.events', reason: 'game/ui emit/on missing' });
        }
    } else {
        failures.push({ area: 'setup', reason: 'no script instance with a scene — clean fixture changed?' });
    }

    if (failures.length === 0) {
        console.log('script-api smoke: OK — wrapper surface intact.');
        process.exit(0);
    }
    console.error(`script-api smoke: ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  ✗ ${f.area} — ${f.reason}`);
    process.exit(1);
}

main().catch(e => {
    console.error('script-api smoke crashed:', e);
    process.exit(2);
});
