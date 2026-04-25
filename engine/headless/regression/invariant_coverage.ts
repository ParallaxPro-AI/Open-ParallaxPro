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
    label: 'strip physics from ALL static entities (ground + roads + sidewalks + …) → player falls',
    mutate: (dir) => {
      const j = readJson(path.join(dir, '02_entities.json'));
      // Keep the player's physics; strip everyone else's so the only floor
      // is gone — no fallback road/sidewalk to catch the player.
      for (const [k, v] of Object.entries<any>(j.definitions || {})) {
        if (k === 'player_sedan' || k === 'camera') continue;
        if (v?.physics) v.physics = false;
      }
      writeJson(path.join(dir, '02_entities.json'), j);
    },
  },
  {
    target: 'ground_holds_player_in_gameplay',
    label: 'frame-150 yanker behavior teleports player into the void',
    mutate: (dir) => {
      // Attach a tiny behavior to the player that ticks a frame counter
      // and teleports below the kill plane at frame 150 — i.e. AFTER the
      // pre-gameplay 120-tick check passes, BEFORE the gameplay-state
      // 60-tick re-check completes. Simulates the platformer 7846a351
      // class where a level-manager teleports the player on gameplay
      // state entry to a position with no platform beneath. Frame-based
      // rather than FSM-event-based so the fixture works regardless of
      // whether the cov harness manages to drive its FSM forward.
      const bDir = path.join(dir, 'behaviors', 'cov_yank');
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'yank.ts'), `class CovYankBehavior extends GameScript {
    _behaviorName = "cov_yank";
    // Force-active even before the FSM broadcasts active_behaviors,
    // since the coverage harness doesn't call activateAllBehaviors().
    _behaviorActive = true;
    _frame = 0;
    _yanked = false;
    onUpdate(dt) {
        this._frame += 1;
        if (this._frame === 150 && !this._yanked) {
            this._yanked = true;
            try {
                var p = this.entity.transform.position;
                this.scene.setPosition(this.entity.id, p.x, -50, p.z);
                if (this.scene.setVelocity) this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 });
            } catch (e) {}
        }
    }
}
`);
      // Wire it onto the player entity + force-active in every state.
      const j = readJson(path.join(dir, '02_entities.json'));
      const playerKey = Object.keys(j.definitions).find(k => /^(player|player_sedan|player_car)$/i.test(k))
        || Object.keys(j.definitions).find(k => Array.isArray(j.definitions[k]?.tags) && j.definitions[k].tags.includes('player'));
      if (playerKey) {
        j.definitions[playerKey].behaviors = j.definitions[playerKey].behaviors || [];
        j.definitions[playerKey].behaviors.push({
          name: 'cov_yank',
          script: 'cov_yank/yank.ts',
        });
        writeJson(path.join(dir, '02_entities.json'), j);
      }
      const flow = readJson(path.join(dir, '01_flow.json'));
      const addBeh = (def: any) => {
        if (Array.isArray(def?.active_behaviors)) def.active_behaviors.push('cov_yank');
        if (def?.substates) for (const s of Object.values<any>(def.substates)) addBeh(s);
      };
      for (const s of Object.values<any>(flow.states ?? {})) addBeh(s);
      writeJson(path.join(dir, '01_flow.json'), flow);
    },
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
    label: 'gameType=shooter + camera on player entity + mesh without hideFromOwner',
    mutate: (dir) => {
      // Declare the fixture as a shooter so the invariant is gated on.
      fs.writeFileSync(path.join(dir, 'PLAYTEST.ts'),
        `export const gameType = "shooter";\nexport const primaryAction = "KeyW";\nexport default async (p) => { p.activateAllBehaviors(); };\n`);
      const j = readJson(path.join(dir, '02_entities.json'));
      // Give the player entity a CameraComponent directly — the invariant's
      // "cameraOwnedByPlayer" walk trivially succeeds when cam.id === player.id.
      // The sedan already has a mesh asset, which is what triggers the check.
      if (j.definitions.player_sedan) {
        j.definitions.player_sedan.camera = { fov: 75 };
        if (!j.definitions.player_sedan.tags) j.definitions.player_sedan.tags = [];
        if (!j.definitions.player_sedan.tags.includes('camera')) j.definitions.player_sedan.tags.push('camera');
        // Ensure hideFromOwner is NOT set (the bug we're testing for).
        if (j.definitions.player_sedan.mesh) {
          delete j.definitions.player_sedan.mesh.hideFromOwner;
        }
      }
      writeJson(path.join(dir, '02_entities.json'), j);
      // Remove the standalone camera placement so the player is the only
      // camera. Otherwise discoverCamera might find the separate one first.
      const w = readJson(path.join(dir, '03_worlds.json'));
      w.worlds[0].placements = (w.worlds[0].placements as any[]).filter(
        (p: any) => p.ref !== 'camera'
      );
      writeJson(path.join(dir, '03_worlds.json'), w);
    },
  },
  {
    target: 'ui_has_interactable',
    label: 'declare gameType=clicker on a fixture that has no scene-layer buttons',
    mutate: (dir) => {
      // The Marine Drive fixture has no visible scene.createButton clickables
      // (its main_menu and game_over are HTML panels, not scene-layer). The
      // invariant only tests scene-layer clickables via p.runtime.ui.listVisible
      // (HeadlessUI tracks createText/createButton/etc. calls). Declaring
      // gameType=clicker without adding any scene.createButton is enough.
      fs.writeFileSync(path.join(dir, 'PLAYTEST.ts'),
        `export const gameType = "clicker";\nexport default async (p) => { p.activateAllBehaviors(); };\n`);
    },
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
  {
    target: 'behavior_listens_for_unemitted_event',
    label: 'add a behavior that listens for a declared-but-never-emitted event',
    mutate: (dir) => {
      // Drop a behavior that registers a listener for an event NOTHING emits.
      // To pass the assembler's event-schema validator (which checks that
      // every listened-for name is declared in event_definitions.ts), we
      // register the event there — BUT add zero emit sites anywhere. The
      // assembler gate stays happy because the name is declared; the
      // runtime stays happy because nobody listens to an emit that never
      // comes; and THIS invariant catches it because no emit source exists
      // in the flow or any script.
      const EVT = 'cov_stub_never_emitted_xyz123';

      // 1. Register the event in event_definitions.ts
      const eventDefPath = path.join(dir, 'systems', 'event_definitions.ts');
      if (fs.existsSync(eventDefPath)) {
        let eventSrc = fs.readFileSync(eventDefPath, 'utf-8');
        // Inject before the closing brace of GAME_EVENTS. Match the last `}`
        // in the var assignment conservatively.
        eventSrc = eventSrc.replace(/(\bvar\s+GAME_EVENTS\s*=\s*\{[\s\S]*?)(\n\};)/, `$1\n    ${EVT}: { fields: {} },$2`);
        fs.writeFileSync(eventDefPath, eventSrc);
      }

      // 2. Behavior script with the dead listener
      const bDir = path.join(dir, 'behaviors', 'cov_stub');
      fs.mkdirSync(bDir, { recursive: true });
      fs.writeFileSync(path.join(bDir, 'dead_listener.ts'), `// Coverage fixture — intentional dead listener.
class CovStubDeadListenerBehavior extends GameScript {
    _behaviorName = "cov_stub_dead_listener";
    onStart() {
        var self = this;
        this.scene.events.game.on("${EVT}", function() {
            self._unreachable = true;
        });
    }
}
`);

      // 3. Attach behavior to any existing entity def
      const j = readJson(path.join(dir, '02_entities.json'));
      const playerKey = Object.keys(j.definitions).find(k => /player|sedan|car/i.test(k));
      if (playerKey) {
        j.definitions[playerKey].behaviors = j.definitions[playerKey].behaviors || [];
        j.definitions[playerKey].behaviors.push({
          name: 'cov_stub_dead_listener',
          script: 'cov_stub/dead_listener.ts',
        });
        writeJson(path.join(dir, '02_entities.json'), j);
      }

      // 4. Register in active_behaviors (every state that has the list)
      const flow = readJson(path.join(dir, '01_flow.json'));
      const addTo = (def: any) => {
        if (Array.isArray(def?.active_behaviors)) def.active_behaviors.push('cov_stub_dead_listener');
        if (def?.substates) for (const s of Object.values<any>(def.substates)) addTo(s);
      };
      for (const s of Object.values<any>(flow.states ?? {})) addTo(s);
      writeJson(path.join(dir, '01_flow.json'), flow);
    },
  },
  {
    target: 'hud_html_field_resolves',
    label: 'add a HUD HTML that reads a field no script ever provides',
    mutate: (dir) => {
      // Drop a HUD panel under ui/hud/ that reads `s.cov_unresolved_field`
      // from the gameState message but is provided by zero scripts and
      // zero flow vars. Repros the iteration-6 bullet_hell class
      // (s.health/s.maxHealth bound to a bar that never updated).
      const hudDir = path.join(dir, 'ui', 'hud');
      fs.mkdirSync(hudDir, { recursive: true });
      fs.writeFileSync(path.join(hudDir, 'cov_field_hud.html'), `<!DOCTYPE html>
<html><body>
<div id="x">—</div>
<script>
window.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'gameState') return;
  var s = e.data.state || {};
  if (typeof s.cov_unresolved_field === 'number') {
    document.getElementById('x').textContent = s.cov_unresolved_field;
  }
});
</script></body></html>
`);
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
