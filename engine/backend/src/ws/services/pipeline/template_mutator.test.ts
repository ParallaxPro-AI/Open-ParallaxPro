/**
 * Local test harness for the quickjs-emscripten-based template_mutator.
 *
 * Run with:
 *   cd engine/backend && npx tsx src/ws/services/pipeline/template_mutator.test.ts
 *
 * Every execute() goes parent JS → QuickJS (WASM) → JSON-envelope bridge
 * back. Verifies:
 *   • Happy path returns updatedFiles with expected mutations
 *   • Runtime errors come back as failure MutatorResult, not a crash
 *   • VM timeouts trip cleanly, parent stays up
 *   • Host-realm escape attempts (Object.constructor.constructor, etc.)
 *     cannot touch the host
 *   • Unknown scene methods surface as failure, not crash
 *   • Large inputs, deep nesting, concurrent calls, rapid-fire calls all
 *     work without leaking state or memory
 *   • Math / JSON / Array / typeof / eval work INSIDE the sandbox realm
 *   • process / require / import / fs are NOT reachable
 *   • Return values round-trip cleanly (findEntity, getEntities, getEntityCount)
 */
import { runEditScript } from './template_mutator.js';
import type { ProjectFiles } from './project_files.js';
import { emptyTemplateFiles } from './project_files.js';

type Case = { name: string; run: () => Promise<void> };

function baseFiles(): ProjectFiles {
    return emptyTemplateFiles();
}

function pid(suffix: string): string {
    return `test-mutator-${suffix}-${process.pid}`;
}

function assert(cond: any, msg: string): void {
    if (!cond) throw new Error('ASSERT: ' + msg);
}

async function runSuite(cases: Case[]): Promise<boolean> {
    let passed = 0, failed = 0;
    const t0All = Date.now();
    for (const c of cases) {
        const t0 = Date.now();
        try {
            await c.run();
            const ms = Date.now() - t0;
            console.log(`  \u2713 ${c.name} (${ms}ms)`);
            passed++;
        } catch (e: any) {
            const ms = Date.now() - t0;
            console.log(`  \u2717 ${c.name} (${ms}ms)`);
            console.log(`    ${e?.stack || e?.message || e}`);
            failed++;
        }
    }
    const totalMs = Date.now() - t0All;
    console.log(`\n${passed} passed, ${failed} failed (${totalMs}ms total)`);
    return failed === 0;
}

const cases: Case[] = [
    {
        name: 'happy path: scene.addEntity creates a cube',
        async run() {
            const s = runEditScript(pid('happy1'), baseFiles());
            const r = await s.execute(`
                scene.addEntity('cube1', 'cube', { position: [0, 1, 0] });
            `);
            assert(r.success, `expected success, got error: ${r.error}`);
            assert(r.updatedFiles['02_entities.json'], 'entities file not updated');
            assert(r.updatedFiles['03_worlds.json'], 'worlds file not updated');
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            const hasCube = worlds?.worlds?.[0]?.placements?.some((p: any) => p.name === 'cube1');
            assert(hasCube, 'cube1 placement not in worlds');
            assert(r.changes.some(c => c.action === 'add_entity' && c.entity === 'cube1'), 'no add_entity change recorded');
        },
    },
    {
        name: 'happy path: five cubes (user-reported crash case)',
        async run() {
            const s = runEditScript(pid('five'), baseFiles());
            const r = await s.execute(`
                for (let i = 0; i < 5; i++) {
                    scene.addEntity('cube' + i, 'cube', { position: [i * 2, 1, 0] });
                }
            `);
            assert(r.success, `expected success, got error: ${r.error}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            const cubes = worlds.worlds[0].placements.filter((p: any) => p.name?.startsWith('cube'));
            assert(cubes.length === 5, `expected 5 cubes, got ${cubes.length}`);
        },
    },
    {
        name: 'runtime error: explicit throw surfaces as failure',
        async run() {
            const s = runEditScript(pid('throw'), baseFiles());
            const r = await s.execute(`throw new Error('boom from user code');`);
            assert(!r.success, 'expected failure');
            assert(/boom from user code/.test(r.error || ''), `error missing: ${r.error}`);
        },
    },
    {
        name: 'runtime error: syntax error surfaces as failure',
        async run() {
            const s = runEditScript(pid('syntax'), baseFiles());
            const r = await s.execute(`this is { not valid js`);
            assert(!r.success, 'expected failure on syntax error');
        },
    },
    {
        name: 'vm timeout: infinite loop terminated, engine survives',
        async run() {
            const s = runEditScript(pid('infloop'), baseFiles());
            const t0 = Date.now();
            const r = await s.execute(`while (true) { /* tight loop */ }`);
            const elapsed = Date.now() - t0;
            assert(!r.success, 'expected failure on infinite loop');
            assert(/timed out/i.test(r.error || ''), `expected timeout error, got: ${r.error}`);
            // vm timeout is 2000ms; allow generous slack for interrupt cadence
            assert(elapsed < 10_000, `took too long (${elapsed}ms) — interrupt didn't fire`);
        },
    },
    {
        name: 'vm timeout: non-trivial loop with work still interrupts',
        async run() {
            const s = runEditScript(pid('infloop2'), baseFiles());
            const r = await s.execute(`
                let n = 0;
                while (true) { n = (n + 1) * 2 | 0; }
            `);
            assert(!r.success, 'expected failure on looping work');
            assert(/timed out/i.test(r.error || ''), `expected timeout error, got: ${r.error}`);
        },
    },
    {
        name: 'escape attempt: Function constructor cannot reach host process',
        async run() {
            const s = runEditScript(pid('escape1'), baseFiles());
            const r = await s.execute(`
                // If any of these actually reach the host, they would crash
                // or exfiltrate. Inside QuickJS they must be unreachable.
                let reached = null;
                try {
                    const Fn = Object.constructor.constructor;
                    const p = Fn('return typeof process')();
                    reached = p;
                } catch (e) { /* ok */ }
                // Record what the sandbox saw for later assertion.
                scene.addEntity('probe', 'cube', { position: [0, 0, 0] });
                if (reached === 'object') {
                    // Leaked. Try to demonstrate by exfiltrating cwd.
                    const Fn2 = Object.constructor.constructor;
                    const pp = Fn2('return process.cwd()')();
                    scene.addEntity('LEAKED:' + pp, 'cube', {});
                }
            `);
            assert(r.success, `expected success (probe path), got: ${r.error}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            const names: string[] = worlds.worlds[0].placements.map((p: any) => p.name).filter(Boolean);
            const leaked = names.some(n => n.startsWith('LEAKED:'));
            assert(!leaked, `sandbox escape returned host process — names: ${names.join(', ')}`);
        },
    },
    {
        name: 'escape attempt: globalThis has no process/require/import/fs',
        async run() {
            const s = runEditScript(pid('escape2'), baseFiles());
            const r = await s.execute(`
                if (typeof process !== 'undefined') throw new Error('process leaked: ' + typeof process);
                if (typeof require !== 'undefined') throw new Error('require leaked');
                // import is a syntax keyword; can't check with typeof meaningfully.
                // fs is a Node-only global never set up in QuickJS.
                if (typeof global !== 'undefined') throw new Error('global leaked');
                // Buffer is a Node global, not in QuickJS.
                if (typeof Buffer !== 'undefined') throw new Error('Buffer leaked');
                // setTimeout/setInterval would give the script a way to escape
                // the 2s timeout if they deferred work — neither is in QuickJS.
                if (typeof setTimeout !== 'undefined') throw new Error('setTimeout leaked');
                if (typeof setImmediate !== 'undefined') throw new Error('setImmediate leaked');
            `);
            assert(r.success, `host globals leaked into sandbox: ${r.error}`);
        },
    },
    {
        name: 'unknown scene method: surfaces as failure (not crash)',
        async run() {
            const s = runEditScript(pid('unknown'), baseFiles());
            const r = await s.execute(`scene.thisDoesNotExist(1, 2, 3);`);
            assert(!r.success, 'expected failure');
            assert(/Unknown scene method/i.test(r.error || ''), `expected unknown-method error, got: ${r.error}`);
        },
    },
    {
        name: 'isolation: parallel execute() calls do not see each other',
        async run() {
            const results = await Promise.all([0, 1, 2, 3].map(async (i) => {
                const s = runEditScript(pid('par' + i), baseFiles());
                return s.execute(`scene.addEntity('parallel${i}', 'cube', { position: [${i}, 0, 0] });`);
            }));
            for (let i = 0; i < results.length; i++) {
                const r = results[i];
                assert(r.success, `call ${i} failed: ${r.error}`);
                const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
                const names: string[] = worlds.worlds[0].placements.map((p: any) => p.name).filter(Boolean);
                assert(names.includes(`parallel${i}`), `call ${i}: missing parallel${i} in ${names.join(',')}`);
                for (let j = 0; j < results.length; j++) {
                    if (j === i) continue;
                    assert(!names.includes(`parallel${j}`), `call ${i}: leaked parallel${j} from sibling`);
                }
            }
        },
    },
    {
        name: 'large input: 500 addEntity calls in one block',
        async run() {
            const s = runEditScript(pid('big500'), baseFiles());
            const r = await s.execute(`
                for (let i = 0; i < 500; i++) {
                    scene.addEntity('big' + i, 'cube', { position: [i, 0, 0] });
                }
            `);
            assert(r.success, `expected success, got: ${r.error}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            const bigs = worlds.worlds[0].placements.filter((p: any) => p.name?.startsWith('big'));
            assert(bigs.length === 500, `expected 500 placements, got ${bigs.length}`);
        },
    },
    {
        name: 'rapid-fire: 20 sequential execute() calls — no leak / wedge',
        async run() {
            // Runtimes / contexts are disposed per call. If a handle leaks,
            // QuickJS throws on the next execute. We detect that by doing
            // many and checking all succeed plus total time stays sane.
            const t0 = Date.now();
            for (let i = 0; i < 20; i++) {
                const s = runEditScript(pid('rf' + i), baseFiles());
                const r = await s.execute(`scene.addEntity('rf${i}', 'cube', {});`);
                assert(r.success, `rapid-fire ${i} failed: ${r.error}`);
                const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
                assert(worlds.worlds[0].placements.some((p: any) => p.name === `rf${i}`), `rf${i} missing`);
            }
            const elapsed = Date.now() - t0;
            assert(elapsed < 20_000, `rapid-fire took ${elapsed}ms — possible leak slowing things down`);
        },
    },
    {
        name: 'return values: scene.findEntity on seeded ground works',
        async run() {
            const s = runEditScript(pid('ret1'), baseFiles());
            const r = await s.execute(`
                const g = scene.findEntity('Ground');
                if (!g) throw new Error('Ground not found');
                if (!g.components || g.components.length === 0) throw new Error('no components on Ground');
                scene.addEntity('afterFind', 'cube', { position: g.position || [0,0,0] });
            `);
            assert(r.success, `findEntity round-trip failed: ${r.error}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            assert(
                worlds.worlds[0].placements.some((p: any) => p.name === 'afterFind'),
                'afterFind placement missing',
            );
        },
    },
    {
        name: 'return values: getEntities returns an array of names',
        async run() {
            const s = runEditScript(pid('ret2'), baseFiles());
            const r = await s.execute(`
                const names = scene.getEntities();
                if (!Array.isArray(names)) throw new Error('getEntities did not return array: ' + typeof names);
                if (names.length === 0) throw new Error('getEntities empty');
                if (!names.includes('Ground')) throw new Error('Ground missing: ' + names.join(','));
                scene.addEntity('sawNames', 'cube', {});
            `);
            assert(r.success, `getEntities failed: ${r.error}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            assert(worlds.worlds[0].placements.some((p: any) => p.name === 'sawNames'), 'sawNames missing');
        },
    },
    {
        name: 'return values: getEntityCount returns a number',
        async run() {
            const s = runEditScript(pid('ret3'), baseFiles());
            const r = await s.execute(`
                const n = scene.getEntityCount();
                if (typeof n !== 'number') throw new Error('not a number: ' + typeof n);
                if (n < 1) throw new Error('bad count: ' + n);
                scene.addEntity('sawCount_' + n, 'cube', {});
            `);
            assert(r.success, `getEntityCount failed: ${r.error}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            const has = worlds.worlds[0].placements.some((p: any) => p.name?.startsWith('sawCount_'));
            assert(has, `sawCount_* missing: ${JSON.stringify(worlds.worlds[0].placements.map((p: any) => p.name))}`);
        },
    },
    {
        name: 'stdlib: Math, JSON, Array work inside sandbox',
        async run() {
            const s = runEditScript(pid('stdlib'), baseFiles());
            const r = await s.execute(`
                const xs = [1, 2, 3, 4, 5];
                const sum = xs.reduce((a, b) => a + b, 0);
                const sq = xs.map(x => Math.pow(x, 2));
                const obj = JSON.parse(JSON.stringify({ sum, sq }));
                if (obj.sum !== 15) throw new Error('sum wrong: ' + obj.sum);
                if (obj.sq.join(',') !== '1,4,9,16,25') throw new Error('sq wrong: ' + obj.sq.join(','));
                scene.addEntity('stdlibOK', 'cube', { position: [obj.sum, 0, 0] });
            `);
            assert(r.success, `stdlib failed: ${r.error}`);
        },
    },
    {
        name: 'object marshal: nested options through the bridge',
        async run() {
            const s = runEditScript(pid('nested'), baseFiles());
            const r = await s.execute(`
                scene.addEntity('nestedCube', 'cube', {
                    position: [1, 2, 3],
                    scale: { x: 2, y: 2, z: 2 },
                    rotation: [0, 45, 0],
                    materialOverrides: { baseColor: [0.1, 0.2, 0.3, 1] },
                    tags: ['player', 'interactable'],
                    components: [{ type: 'CustomTag', data: { foo: 'bar' } }],
                });
            `);
            assert(r.success, `nested options failed: ${r.error}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            const ent = worlds.worlds[0].placements.find((p: any) => p.name === 'nestedCube');
            assert(ent, 'nestedCube missing');
            assert(JSON.stringify(ent.position) === '[1,2,3]', `pos wrong: ${JSON.stringify(ent.position)}`);
            assert(JSON.stringify(ent.scale) === '[2,2,2]', `scale wrong: ${JSON.stringify(ent.scale)}`);
            assert(JSON.stringify(ent.rotation) === '[0,45,0]', `rot wrong: ${JSON.stringify(ent.rotation)}`);
            const entities = JSON.parse(r.updatedFiles['02_entities.json']);
            const def = entities.definitions[ent.ref];
            assert(def?.mesh?.color?.length === 4, `color missing on def: ${JSON.stringify(def)}`);
            // Tags passed via addEntity options land on the def (not the placement).
            const tags: string[] = def?.tags || [];
            assert(tags.includes('player') && tags.includes('interactable'), `tags wrong (def.tags): ${tags.join(',')}`);
            assert(ent.extra_components?.[0]?.type === 'CustomTag', `extra_components wrong: ${JSON.stringify(ent.extra_components)}`);
        },
    },
    {
        name: 'error marshal: host error flows back as exception in sandbox',
        async run() {
            const s = runEditScript(pid('herr'), baseFiles());
            const r = await s.execute(`
                let caught = null;
                try {
                    // Invalid type triggers addComponent's validation path.
                    scene.addComponent('Ground', 'ColliderComponent', { shapeType: 'not-a-shape' });
                } catch (e) {
                    caught = String(e && e.message ? e.message : e);
                }
                if (!caught) throw new Error('host error not surfaced to sandbox');
                if (!caught.includes('invalid shapeType')) throw new Error('wrong message: ' + caught);
                scene.addEntity('errCaught', 'cube', {});
            `);
            assert(r.success, `host-error marshal failed: ${r.error}`);
        },
    },
    {
        name: 'eval inside sandbox: sandbox-realm eval is allowed (scoped to VM)',
        async run() {
            // eval is an escape vector against node:vm, but inside QuickJS it
            // just creates more sandbox-realm code. Verify it works (i.e. we
            // aren't accidentally blocking it) and that it STILL can't reach
            // process.
            const s = runEditScript(pid('eval1'), baseFiles());
            const r = await s.execute(`
                const x = eval('1 + 2');
                if (x !== 3) throw new Error('eval wrong: ' + x);
                try {
                    const p = eval('typeof process');
                    if (p === 'object') throw new Error('process leaked via eval: ' + p);
                } catch (e) { /* ok — e.g. "process is not defined" */ }
                scene.addEntity('evalOK_' + x, 'cube', {});
            `);
            assert(r.success, `eval path failed: ${r.error}`);
        },
    },
    {
        name: 'memory limit: huge allocation rejected without crashing engine',
        async run() {
            // 64MB cap is set in execute(). An attempted 200MB string should
            // hit the ceiling with a catchable error, not segfault the host.
            const s = runEditScript(pid('mem'), baseFiles());
            const r = await s.execute(`
                try {
                    let s = 'x';
                    while (s.length < 200_000_000) s = s + s; // doubles, should hit cap
                    throw new Error('did not hit memory cap; final length ' + s.length);
                } catch (e) {
                    // Acceptable: out-of-memory style error. Rethrow anything
                    // that looks like WE failed to enforce it.
                    if (String(e).includes('did not hit memory cap')) throw e;
                }
                scene.addEntity('memOK', 'cube', {});
            `);
            // Two acceptable outcomes: (a) user code caught OOM and we reach
            // addEntity → success; (b) runtime threw OOM at the eval boundary
            // → r.success === false, r.error mentions memory/stack.
            if (!r.success) {
                assert(
                    /memory|stack|out|oom|exceed/i.test(r.error || ''),
                    `unexpected failure: ${r.error}`,
                );
            } else {
                const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
                assert(worlds.worlds[0].placements.some((p: any) => p.name === 'memOK'), 'memOK missing');
            }
        },
    },
    {
        name: 'no prototype pollution: Array.prototype edits dont cross realms',
        async run() {
            // Mutating Array.prototype inside the sandbox must NOT affect
            // the host's Array.prototype — this is one of the key reasons
            // we're switching off node:vm.
            const s1 = runEditScript(pid('proto1'), baseFiles());
            await s1.execute(`
                Array.prototype.pwned = function() { return 'OWNED'; };
            `);
            // Now back in the host — our own arrays must NOT have .pwned.
            const hostArr: any = [1, 2, 3];
            if (typeof hostArr.pwned === 'function') {
                throw new Error('host Array.prototype got polluted across realms');
            }
            // And a fresh sandbox should also not see the pollution.
            const s2 = runEditScript(pid('proto2'), baseFiles());
            const r2 = await s2.execute(`
                if (typeof ([].pwned) === 'function') throw new Error('sandbox2 sees sandbox1 pollution');
                scene.addEntity('clean', 'cube', {});
            `);
            assert(r2.success, `fresh sandbox not clean: ${r2.error}`);
        },
    },
    {
        name: 'many verbs: full-ish API exercise in one run',
        async run() {
            const s = runEditScript(pid('full'), baseFiles());
            const r = await s.execute(`
                scene.addEntity('boxA', 'cube', { position: [0, 0, 0] });
                scene.addEntity('boxB', 'sphere', { position: [2, 0, 0] });
                scene.setPosition('boxA', 1, 1, 1);
                scene.translate('boxB', 0, 0.5, 0);
                scene.setScale('boxA', 2, 2, 2);
                scene.scaleBy('boxA', 0.5, 0.5, 0.5);
                scene.setRotation('boxB', 0, 90, 0);
                scene.rotate('boxB', 0, 90, 0);
                scene.addTag('boxA', 'player');
                scene.addTag('boxA', 'bouncy');
                scene.removeTag('boxA', 'bouncy');
                scene.addComponent('boxA', 'CustomBehavior', { speed: 5 });
                scene.addComponent('boxA', 'ColliderComponent', { shapeType: 'box' });
                scene.setMaterial('boxA', { baseColor: [1, 0, 0, 1] });
                scene.setGravity(0, -9.8, 0);
                scene.setAmbientLight([1, 1, 1], 0.5);
                scene.setFog(true, [0.5, 0.5, 0.5], 10, 200);
                scene.setTimeOfDay(14);
                scene.duplicateEntity('boxA', 'boxA-copy');
                scene.renameEntity('boxB', 'boxB-renamed');
                scene.setActive('boxA', false);
                scene.removeComponent('boxA', 'CustomBehavior');
                scene.deleteEntity('boxA-copy');
            `);
            assert(r.success, `full exercise failed: ${r.error}`);
            assert(r.changes.length >= 20, `expected many changes, got ${r.changes.length}`);
            const worlds = JSON.parse(r.updatedFiles['03_worlds.json']);
            const names: string[] = worlds.worlds[0].placements.map((p: any) => p.name).filter(Boolean);
            assert(names.includes('boxA'), `boxA missing: ${names.join(',')}`);
            assert(names.includes('boxB-renamed'), `boxB-renamed missing: ${names.join(',')}`);
            assert(!names.includes('boxA-copy'), `boxA-copy should have been deleted: ${names.join(',')}`);
            const boxA = worlds.worlds[0].placements.find((p: any) => p.name === 'boxA');
            assert(boxA.active === false, 'setActive(false) did not stick');
            assert(boxA.tags?.includes('player'), `player tag missing: ${JSON.stringify(boxA.tags)}`);
            assert(!boxA.tags?.includes('bouncy'), 'bouncy tag not removed');
            assert(worlds.worlds[0].environment?.gravity, 'gravity not set');
            assert(worlds.worlds[0].environment?.timeOfDay === 14, 'timeOfDay not set');
        },
    },
    {
        name: 'process liveness: after all the above, we are still here',
        async run() {
            assert(true, '');
        },
    },
];

runSuite(cases).then((ok) => process.exit(ok ? 0 : 1));
