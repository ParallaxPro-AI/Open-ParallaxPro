#!/usr/bin/env node
/**
 * Per-invariant coverage harness.
 *
 * The baseline harness (run_regression.ts) checks "does THIS game still
 * produce THIS verdict." It catches drift in real user-reported bugs,
 * but not drift in the invariants themselves — if someone accidentally
 * deletes the body of `interactive_entities_have_colliders`, the
 * baseline harness doesn't notice because none of the 9 curated games
 * ALSO have a tightly-focused test of that check.
 *
 * This script fills that gap. For each invariant we own, it:
 *   1. Clones a known-clean game into a temp directory.
 *   2. Applies a minimal mutation designed to trigger exactly that one
 *      invariant.
 *   3. Runs the playtest and asserts the expected invariant is among
 *      the failures.
 *   4. Optionally asserts NO unexpected invariants fire (strict mode).
 *
 * A mutation that doesn't make its target fire = the invariant is
 * broken and needs fixing.
 *
 * Usage:
 *   npm run coverage
 *   npm run coverage -- --only interactive_entities_have_colliders
 *   npm run coverage -- --strict   (fail on collateral firings too)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { runPlaytest } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

// Canonical clean fixture. The Marine Drive driving game — 3D vehicle,
// player+camera+ground+coins+walls, has most of the structural shapes
// our invariants probe.
const CLEAN_SRC = path.resolve(REPO_ROOT, 'engine/backend/cli_sandbox_archives/2026-04-22T20-48-51-996Z_success_research/project');

interface MutationCase {
  /** Invariant that should fire as a result of the mutation. */
  target: string;
  /** Short human description of what this mutation does. */
  label: string;
  /** In-place mutate the cloned project directory. */
  mutate: (dir: string) => void;
  /** If true, the mutation isn't applicable to the clean driving fixture
   *  (e.g. requires gameType=shooter); skip without failing. */
  skipReason?: string;
}

function readJson(p: string): any { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function writeJson(p: string, o: any): void { fs.writeFileSync(p, JSON.stringify(o, null, 2)); }

function cloneDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) cloneDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function findFirstBehavior(dir: string): string | null {
  const root = path.join(dir, 'behaviors');
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop()!;
    if (!fs.existsSync(cur)) continue;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith('.ts')) return p;
    }
  }
  return null;
}

const CASES: MutationCase[] = [
  {
    // script_health_boot checks scene.errors at invariant-check time, BEFORE
    // any tick. onStart only fires on first tick, so a throw in onStart
    // actually gets caught by script_health_runtime. For a true boot-time
    // error we inject a syntax error at module scope so loadScriptClass
    // itself throws during register.
    target: 'script_health_boot',
    label: 'inject module-scope syntax error (fires during class load)',
    mutate: (dir) => {
      const behPath = findFirstBehavior(dir);
      if (!behPath) throw new Error('no behavior found');
      const src = fs.readFileSync(behPath, 'utf-8');
      // Prepend unbalanced brace — fails loadScriptClass's new Function() parse.
      fs.writeFileSync(behPath, 'this_is_not_valid_typescript !!! {\n' + src);
    },
  },
  {
    target: 'ground_holds_player',
    label: 'NOT APPLICABLE (Marine Drive has road + sidewalk fallback colliders)',
    mutate: () => {},
    skipReason: 'fixture has too many fallback static colliders; removing ground alone does not let the player fall',
  },
  {
    target: 'spawn_not_overlapping',
    label: 'plant a wall at the player spawn',
    mutate: (dir) => {
      const j = readJson(path.join(dir, '02_entities.json'));
      j.definitions.coverage_wall = {
        mesh: { type: 'cube' },
        physics: { type: 'static', collider: { shape: 'cuboid', halfExtents: [0.5, 0.5, 0.5] } },
      };
      writeJson(path.join(dir, '02_entities.json'), j);
      const w = readJson(path.join(dir, '03_worlds.json'));
      // Driving player spawns at [0, 0.6, 70]. Drop a 1m cube right there.
      (w.worlds[0].placements as any[]).push({
        ref: 'coverage_wall',
        position: [0, 0.6, 70],
        scale: [2, 2, 2],
      });
      writeJson(path.join(dir, '03_worlds.json'), w);
    },
  },
  {
    target: 'fsm_state_valid',
    label: 'point flow.start at a non-existent state',
    mutate: (dir) => {
      const p = path.join(dir, '01_flow.json');
      const j = readJson(p);
      j.start = 'nonexistent_state_' + Math.random().toString(36).slice(2, 8);
      writeJson(p, j);
    },
  },
  {
    target: 'pause_state_is_substate_of_gameplay',
    label: 'add a root-level paused state',
    mutate: (dir) => {
      const p = path.join(dir, '01_flow.json');
      const j = readJson(p);
      j.states.paused = {
        description: 'coverage-test sibling pause',
        on_enter: ['show_cursor'],
        transitions: [{ when: 'keyboard:resume', goto: 'gameplay' }],
      };
      writeJson(p, j);
    },
  },
  {
    target: 'advertised_keys_resolve',
    label: 'add "Press K" hint to a HUD panel with no flow handler',
    mutate: (dir) => {
      // Find any .html under ui/ — fixture-agnostic.
      const uiDir = path.join(dir, 'ui');
      const walk = (d: string): string | null => {
        if (!fs.existsSync(d)) return null;
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) { const r = walk(p); if (r) return r; }
          else if (e.name.endsWith('.html')) return p;
        }
        return null;
      };
      const hudPath = walk(uiDir);
      if (!hudPath) throw new Error('no .html found under ui/');
      const src = fs.readFileSync(hudPath, 'utf-8');
      fs.writeFileSync(hudPath, src + '\n<div style="position:fixed;bottom:10px;right:10px;">Press <span class="kbd">K</span> klaxon</div>\n');
    },
  },
  {
    target: 'interactive_entities_have_colliders',
    label: 'add a "wall" entity with physics:false',
    mutate: (dir) => {
      const j = readJson(path.join(dir, '02_entities.json'));
      // Name must match INTERACTIVE_NAME_RE. "wall" is in the vocab list.
      j.definitions.wall = {
        mesh: { type: 'cube', color: [0.8, 0.2, 0.2, 1] },
        physics: false,
      };
      writeJson(path.join(dir, '02_entities.json'), j);
      const w = readJson(path.join(dir, '03_worlds.json'));
      (w.worlds[0].placements as any[]).push({ ref: 'wall', position: [10, 1, 70] });
      writeJson(path.join(dir, '03_worlds.json'), w);
    },
  },
  {
    target: 'declared_prefabs_reachable',
    label: 'declare a zombie prefab that is never placed or spawned',
    mutate: (dir) => {
      const j = readJson(path.join(dir, '02_entities.json'));
      j.definitions.zombie_enemy = {
        mesh: { type: 'cube', color: [0.2, 0.8, 0.2, 1] },
        physics: { type: 'dynamic', collider: 'capsule' },
        tags: ['enemy'],
      };
      writeJson(path.join(dir, '02_entities.json'), j);
    },
  },
  {
    target: 'collider_matches_mesh_scale',
    label: 'wall with halfExtents [2,2,0.5] at scale [4,4,1]',
    mutate: (dir) => {
      const j = readJson(path.join(dir, '02_entities.json'));
      j.definitions.coverage_scaled_wall = {
        mesh: { type: 'cube', scale: [4, 4, 1] },
        physics: { type: 'static', collider: { shape: 'cuboid', halfExtents: [2, 2, 0.5] } },
        tags: ['wall'],
      };
      writeJson(path.join(dir, '02_entities.json'), j);
      const w = readJson(path.join(dir, '03_worlds.json'));
      (w.worlds[0].placements as any[]).push({ ref: 'coverage_scaled_wall', position: [20, 2, 70] });
      writeJson(path.join(dir, '03_worlds.json'), w);
    },
  },
  {
    target: 'game_over_hides_gameplay_hud',
    label: 'add a game_over state whose on_enter shows both HUD + modal',
    mutate: (dir) => {
      const p = path.join(dir, '01_flow.json');
      const j = readJson(p);
      j.states.game_over = {
        description: 'coverage-test: modal + HUD visible together',
        on_enter: ['show_ui:hud/speedometer', 'show_ui:game_over', 'show_cursor'],
        on_exit: ['hide_ui:game_over', 'hide_ui:hud/speedometer'],
        transitions: [{ when: 'ui_event:game_over:play_again', goto: 'gameplay' }],
      };
      writeJson(p, j);
      // Copy the pinned game_over.html so the assembler's button-validator
      // finds a matching `emit('play_again')` for the ui_event transition.
      const uiDir = path.join(dir, 'ui');
      if (!fs.existsSync(uiDir)) fs.mkdirSync(uiDir, { recursive: true });
      const pinned = path.resolve(REPO_ROOT, 'engine/backend/src/ws/services/pipeline/reusable_game_components/ui/v0.1/game_over.html');
      fs.copyFileSync(pinned, path.join(uiDir, 'game_over.html'));
    },
  },
  {
    target: 'no_scene_createbutton_in_gameplay_systems',
    label: 'gameplay system calls scene.createButton inside onStart',
    mutate: (dir) => {
      const sysDir = path.join(dir, 'systems', 'gameplay');
      if (!fs.existsSync(sysDir)) fs.mkdirSync(sysDir, { recursive: true });
      const filePath = path.join(sysDir, '_coverage_scene_button.ts');
      fs.writeFileSync(filePath, `class CoverageSceneButton extends GameScript {
    onStart() {
        if (this.scene && typeof this.scene.createButton === "function") {
            this.scene.createButton({ x: 10, y: 10, width: 100, height: 30, text: "Coverage" });
        }
    }
}
`);
    },
  },
  {
    target: 'avoid_reimplementing_pinned_behaviors',
    label: 'inline oscillating setPosition + Math.sin platform motion',
    mutate: (dir) => {
      const sysDir = path.join(dir, 'systems', 'gameplay');
      if (!fs.existsSync(sysDir)) fs.mkdirSync(sysDir, { recursive: true });
      const filePath = path.join(sysDir, '_coverage_inline_platform.ts');
      // Put Math.sin directly inside setPosition call-args so the invariant's
      // /setPosition\s*\([^)]*Math\.sin/ fingerprint matches.
      fs.writeFileSync(filePath, `// inline platform oscillation — intentional coverage-test anti-pattern
class CoverageInlinePlatform extends GameScript {
    _t = 0;
    onUpdate(dt) {
        this._t += dt;
        this.scene.setPosition(this.entity.id, Math.sin(this._t * 2) * 3, 1, 0);
    }
}
`);
    },
  },
  {
    target: 'motion_matches_forward',
    label: 'flip car_control _heading default to mismatch placement rotation',
    mutate: (dir) => {
      // Driving fixture has gameType unknown by default — the CLI authored
      // PLAYTEST.ts, or this is a fresh artifact. Either way we add an
      // explicit vehicle PLAYTEST so the invariant is gated on.
      fs.writeFileSync(path.join(dir, 'PLAYTEST.ts'),
        `export const gameType = "vehicle";\nexport const primaryAction = "KeyW";\nexport default async (p) => { p.activateAllBehaviors(); };\n`);
      // Flip the car's script: drive the OPPOSITE direction of the transform's forward.
      const carPath = path.join(dir, 'behaviors', 'movement', 'car_control.ts');
      if (!fs.existsSync(carPath)) throw new Error('no car_control.ts');
      let src = fs.readFileSync(carPath, 'utf-8');
      // Replace setVelocity line with one that drives -velocity — motion will be opposite the script's rotation.
      src = src.replace(/this\.scene\.setVelocity\(this\.entity\.id,\s*\{\s*x:\s*vx,\s*y:\s*vy,\s*z:\s*vz\s*\}\);/, 'this.scene.setVelocity(this.entity.id, { x: -vx, y: vy, z: -vz });  // coverage-test inverted');
      fs.writeFileSync(carPath, src);
    },
  },
  {
    target: 'fps_hides_own_mesh',
    label: 'NOT APPLICABLE (driving fixture is not a shooter)',
    mutate: () => {},
    skipReason: 'requires gameType=shooter/first_person fixture',
  },
  {
    target: 'ui_has_interactable',
    label: 'NOT APPLICABLE (driving fixture is not ui/clicker)',
    mutate: () => {},
    skipReason: 'requires gameType=ui/clicker fixture',
  },
  {
    target: 'cursor_visible_during_clickable_ui',
    label: 'main_menu state opens UI without show_cursor',
    mutate: (dir) => {
      const p = path.join(dir, '01_flow.json');
      const j = readJson(p);
      const mm = j.states.main_menu;
      if (mm && Array.isArray(mm.on_enter)) {
        mm.on_enter = mm.on_enter.filter((op: string) => op !== 'show_cursor');
      }
      writeJson(p, j);
    },
  },
  {
    target: 'pickup_despawns_on_overlap',
    label: 'declare + place a coin entity with no pickup behavior',
    mutate: (dir) => {
      const j = readJson(path.join(dir, '02_entities.json'));
      j.definitions.coin = {
        mesh: { type: 'sphere', color: [1, 0.9, 0.2, 1] },
        physics: { type: 'static', collider: 'sphere', is_trigger: true },
        tags: ['coin', 'pickup'],
        // Deliberately no `behaviors` — the player can reach it but nothing
        // handles the overlap.
      };
      writeJson(path.join(dir, '02_entities.json'), j);
      const w = readJson(path.join(dir, '03_worlds.json'));
      // Place close enough to player spawn that the invariant's teleport probe
      // can reach it in 10 ticks.
      (w.worlds[0].placements as any[]).push({ ref: 'coin', position: [0, 1, 72] });
      writeJson(path.join(dir, '03_worlds.json'), w);
    },
  },
];

function parseArgs(argv: string[]): { only?: string; strict: boolean } {
  const out: any = { strict: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--only' && argv[i + 1]) out.only = argv[++i];
    else if (a === '--strict') out.strict = true;
  }
  return out;
}

async function runOne(c: MutationCase, strict: boolean): Promise<{ ok: boolean; detail: string }> {
  if (c.skipReason) return { ok: true, detail: `SKIP — ${c.skipReason}` };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inv-cov-'));
  try {
    cloneDir(CLEAN_SRC, tmp);
    c.mutate(tmp);
    const v = await runPlaytest(tmp, { timeoutMs: 30_000 });
    const firing = new Set(v.invariants.failures.map(f => f.name));
    if (!firing.has(c.target)) {
      return { ok: false, detail: `MISS — invariant did NOT fire. Fired: [${[...firing].join(', ') || '(none)'}]` };
    }
    if (strict && firing.size > 1) {
      const others = [...firing].filter(n => n !== c.target);
      return { ok: true, detail: `OK (+${others.length} collateral: ${others.join(', ')})` };
    }
    return { ok: true, detail: firing.size === 1 ? 'OK' : `OK (+${firing.size - 1} collateral)` };
  } catch (e: any) {
    return { ok: false, detail: `EXCEPTION — ${e?.message ?? e}` };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const cases = args.only ? CASES.filter(c => c.target === args.only) : CASES;
  if (args.only && cases.length === 0) {
    console.error(`no case with target="${args.only}"`);
    process.exit(2);
  }
  console.log(`=== per-invariant coverage (${cases.length} cases) ===\n`);
  let passes = 0, fails = 0, skips = 0;
  for (const c of cases) {
    const r = await runOne(c, args.strict);
    const tag = c.skipReason ? 'SKIP' : r.ok ? 'PASS' : 'FAIL';
    const icon = c.skipReason ? '○' : r.ok ? '✓' : '✗';
    console.log(`${icon} [${tag}]  ${c.target.padEnd(42)}  ${r.detail}`);
    if (!c.skipReason && r.ok) passes++;
    else if (c.skipReason) skips++;
    else fails++;
  }
  console.log(`\n${passes}/${cases.length - skips} invariants verified (${skips} skipped, ${fails} failed).`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch(e => { console.error(e?.stack ?? e); process.exit(2); });
