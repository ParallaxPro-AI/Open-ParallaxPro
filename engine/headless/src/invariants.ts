/**
 * Tier-1 invariants — checks that apply to every game, derived from the live
 * REAL-engine scene state. Catches the majority of CREATE_GAME failure modes
 * that slip past the assembler (player stuck inside geometry at spawn,
 * missing ground collider, dead controls, onUpdate crashes, unreachable UI).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Playtest, PlaytestFailure, EntityRef } from './playtest.js';
import { analyzeFlow as analyzeHudOverlaps } from './hud_overlap.js';

export interface InvariantResult {
  name: string;
  failure: PlaytestFailure | null;
  skipped?: boolean;
  skipReason?: string;
}

// Tags an entity defines that should exclude it from invariants that
// look for "interactive" or "pickup-shaped" entities by name. The agents
// already use `decoration_only` to mark backdrop props; the others are
// here for cross-genre robustness. Centralised so multiple invariants
// (interactive_entities_have_colliders, pickup_despawns_on_overlap,
// replay_pickup_still_works) can share the rule.
const NON_INTERACTIVE_TAGS = new Set([
  'decoration_only', 'no_collide', 'vfx', 'particle',
  'backdrop', 'background', 'effect',
]);
function isDecorative(def: any): boolean {
  const tags = def?.tags;
  if (!Array.isArray(tags) && !(tags instanceof Set)) return false;
  const list: string[] = tags instanceof Set ? Array.from(tags) : tags;
  for (const t of list) {
    if (typeof t === 'string' && NON_INTERACTIVE_TAGS.has(t)) return true;
  }
  return false;
}

/** Heuristic player discovery against the REAL Scene. Order:
 *   1. Entity tagged "player"
 *   2. Entity whose name contains "player"
 *   3. Entity with a player-shaped behavior script attached
 *   4. First entity with a dynamic rigidbody
 */
export function discoverPlayer(p: Playtest): EntityRef | null {
  const tagged = p.findByTag('player');
  if (tagged) return tagged;
  const scene: any = p.runtime.scene;
  if (!scene) return null;
  for (const e of scene.entities.values()) {
    if (/player/i.test(e.name)) return { id: e.id, name: e.name };
  }
  for (const e of scene.entities.values()) {
    const sc: any = e.getComponent('ScriptComponent');
    if (!sc) continue;
    const url: string = sc.scriptURL || sc.scriptAssetUUID || '';
    if (/player|car_control|character|controller/i.test(url)) {
      return { id: e.id, name: e.name };
    }
  }
  for (const e of scene.entities.values()) {
    const rb: any = e.getComponent('RigidbodyComponent');
    const bodyType = rb?.bodyType ?? rb?.type;
    // Dynamic can be encoded as string 'dynamic' or enum value 2 depending on version.
    if (bodyType === 'dynamic' || bodyType === 2 || bodyType === 1) return { id: e.id, name: e.name };
  }
  return null;
}

export function discoverCamera(p: Playtest): EntityRef | null {
  const tagged = p.findByTag('camera');
  if (tagged) return tagged;
  const scene: any = p.runtime.scene;
  if (!scene) return null;
  for (const e of scene.entities.values()) {
    if (e.getComponent('CameraComponent')) return { id: e.id, name: e.name };
  }
  return null;
}

export function runInvariants(p: Playtest, opts?: { gameType?: string; primaryAction?: string; requirePlayer?: boolean }): InvariantResult[] {
  const results: InvariantResult[] = [];
  const gameType = opts?.gameType ?? 'unknown';
  const primaryAction = opts?.primaryAction;

  // ── 1. Script errors during onStart / registration ──
  results.push(guarded('script_health_boot', () => { p.assertNoErrors(); }));

  // ── 2. Player discovery + settle BEFORE the overlap check. A correctly-
  //      authored game often has the player spawn slightly clipping into the
  //      ground (player's AABB bottom below ground's AABB top by < player
  //      half-height) — physics resolves this in one frame. A real
  //      "stuck in a wall" bug doesn't resolve; the player keeps intersecting
  //      after several frames of integration. So we settle briefly and then
  //      check. ──
  const playerEarly = discoverPlayer(p);
  try { p.tick(5); } catch {}
  if (playerEarly) {
    // Iteration 7 audit improvement: when spawn overlap fires, compute a
    // suggested clear-of-ground Y from the overlapping entities' AABBs and
    // include it in the failure detail so the author has a concrete number
    // to plug into 03_worlds.json instead of guessing. We re-compute AABBs
    // inline (the Playtest class's entityAABB is file-private) using the
    // same TransformComponent + ColliderComponent fields the engine uses.
    const computeAABB = (ent: any): { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } } | null => {
      const tc: any = ent?.getComponent?.('TransformComponent');
      const cc: any = ent?.getComponent?.('ColliderComponent');
      if (!tc || !cc) return null;
      const pos = tc.position, sc = tc.scale ?? { x: 1, y: 1, z: 1 };
      const he = cc.halfExtents;
      const st = cc.shapeType;
      if (st === 1) {
        const r = (cc.radius ?? 0.5) * Math.max(Math.abs(sc.x), Math.abs(sc.y), Math.abs(sc.z));
        return { min: { x: pos.x - r, y: pos.y - r, z: pos.z - r }, max: { x: pos.x + r, y: pos.y + r, z: pos.z + r } };
      }
      if (st === 2) {
        const r = (cc.radius ?? 0.5) * Math.max(Math.abs(sc.x), Math.abs(sc.z));
        const h = (cc.height ?? 1.0) * Math.abs(sc.y);
        return { min: { x: pos.x - r, y: pos.y - h * 0.5, z: pos.z - r }, max: { x: pos.x + r, y: pos.y + h * 0.5, z: pos.z + r } };
      }
      if (he && typeof he.x === 'number') {
        return {
          min: { x: pos.x - he.x * Math.abs(sc.x), y: pos.y - he.y * Math.abs(sc.y), z: pos.z - he.z * Math.abs(sc.z) },
          max: { x: pos.x + he.x * Math.abs(sc.x), y: pos.y + he.y * Math.abs(sc.y), z: pos.z + he.z * Math.abs(sc.z) },
        };
      }
      return null;
    };
    results.push(guarded('spawn_not_overlapping', () => {
      try {
        p.assertNotStuck(playerEarly);
      } catch (e: any) {
        if (e instanceof PlaytestFailure && e.code === 'spawn_overlap') {
          // Augment the existing failure with a suggested Y.
          const scene: any = p.runtime.scene;
          const playerE: any = scene?.entities?.get(playerEarly.id);
          const stuckIn: any[] = (e.detail?.stuckIn as any[]) ?? [];
          let suggestedY: number | null = null;
          if (playerE && stuckIn.length > 0) {
            const playerAabb = computeAABB(playerE);
            if (playerAabb) {
              // Pick the highest top-of-AABB among the entities we're stuck in
              // — that's the surface we want to land on.
              let groundTop = -Infinity;
              for (const sref of stuckIn) {
                const ge: any = scene?.entities?.get(sref.id);
                const ga = computeAABB(ge);
                if (ga && ga.max.y > groundTop) groundTop = ga.max.y;
              }
              if (isFinite(groundTop)) {
                const playerHalfH = (playerAabb.max.y - playerAabb.min.y) / 2;
                suggestedY = groundTop + playerHalfH + 0.02;
                e.detail = { ...e.detail, suggestedY };
              }
            }
          }
          if (suggestedY != null) {
            // Prepend a clear, human-readable suggestion to the hint without
            // dropping the original message. The orchestrator surfaces hint
            // verbatim to the author, so prepending "Try y=N." keeps it
            // first. Also update `message` so callers reading Error.message
            // see the same enriched text.
            (e as any).hint = `Try setting the player's spawn y=${suggestedY.toFixed(2)} (just above the highest ground/collider it currently overlaps). ` + e.hint;
            (e as any).message = `[${e.code}] ${(e as any).hint}`;
          }
        }
        throw e;
      }
    }));
    results.push(guarded('spawn_position_valid', () => { p.assertPositionNotNaN(playerEarly); }));
  }

  const player = playerEarly ?? discoverPlayer(p);
  const isPureUI = gameType === 'ui' || gameType === 'board' || gameType === 'paddle_2d' || gameType === 'clicker';

  if (!player) {
    if (opts?.requirePlayer || ['locomotion_3d', 'vehicle', 'platformer', 'shooter'].includes(gameType)) {
      results.push({ name: 'player_exists', failure: new PlaytestFailure('no_player', `no entity matches the player heuristic (no "player" tag, no player-named prefab, no player-shaped behavior)`, { hint: 'Tag the player entity with "player" in 02_entities.json.' }) });
    } else if (!isPureUI) {
      results.push({ name: 'player_exists', failure: null, skipped: true, skipReason: 'no player discovered; gameType permits it' });
    } else {
      results.push({ name: 'player_exists', failure: null, skipped: true, skipReason: 'UI/board game, no player needed' });
    }
  } else {
    results.push({ name: 'player_exists', failure: null });

    // ── 4. Fall-through check: tick under gravity, verify the player doesn't
    //      escape through the floor. Snapshot so downstream tests aren't
    //      affected by physics settling.
    //
    //      Runs TWICE: once in whatever initial FSM state the game boots
    //      into (catches bad placements / static-geometry gaps), and once
    //      AFTER driving the FSM to the gameplay state (catches bugs in
    //      level-init systems that teleport the player on state entry —
    //      platformer run 7846a351 had `_spawnY = 2` hardcoded that
    //      teleported the player into empty space below every platform
    //      the moment gameplay started. Pre-gameplay-only checks missed
    //      it because the teleport hadn't fired yet.).
    const snap = p.snapshot();
    const before = p.pos(player);
    if (before) {
      try {
        p.tick(120);  // ~2 seconds in initial state
        const fallThreshold = Math.min(before.y - 3, -5);
        results.push(guarded('ground_holds_player', () => { p.assertYAbove(player, fallThreshold); }));
        results.push(guarded('script_health_runtime', () => { p.assertNoErrors(); }));
        results.push(guarded('no_nan_position', () => { p.assertPositionNotNaN(player); }));

        // Drive the FSM to a gameplay-ish state by emitting the common
        // ui-event transitions. The emits are best-effort — if the flow
        // listens for a differently-named ui_event, nothing happens and
        // the re-check is effectively the same as the first check.
        const scriptScene: any = (p.runtime as any).scriptScene;
        if (scriptScene?.events?.ui?.emit) {
          try { scriptScene.events.ui.emit('ui_event:main_menu:start_game'); } catch {}
          try { scriptScene.events.ui.emit('ui_event:main_menu:play'); } catch {}
          try { scriptScene.events.ui.emit('ui_event:main_menu:start'); } catch {}
        }
        p.tick(60);  // settle ~1s into gameplay state
        const afterGameplayY = p.pos(player);
        if (afterGameplayY) {
          results.push(guarded('ground_holds_player_in_gameplay', () => {
            // Looser threshold than the pre-gameplay check — gameplay-state
            // respawn systems can legitimately move the player slightly
            // lower. But not by more than 3 units below the starting pos,
            // and never below -5 absolute.
            const threshold = Math.min(before.y - 3, -5);
            if (afterGameplayY.y < threshold) {
              throw new PlaytestFailure('fell_through_world_in_gameplay',
                `After driving the FSM to gameplay state, player y=${afterGameplayY.y.toFixed(2)} fell below threshold ${threshold.toFixed(2)}. ` +
                `Started at y=${before.y.toFixed(2)}. This usually means a gameplay system teleports the player to a position with no platform/ground beneath — ` +
                `check _spawnX/Y/Z in any level-manager system against the actual platform/floor placements in 03_worlds.json.`,
                { startY: before.y, endY: afterGameplayY.y });
            }
          }));
        }
      } catch (e: any) {
        results.push({ name: 'ground_holds_player', failure: e instanceof PlaytestFailure ? e : new PlaytestFailure('tick_crash', String(e?.message ?? e)) });
      }
      p.restore(snap);
    }

    // ── 5. Responsiveness: hold primary action, something should change.
    //    For vehicles we also verify the motion direction aligns with the
    //    model's visible facing — catches the "driving backwards" class where
    //    the mesh's front-axis and the script's forward vector disagree
    //    (usually a modelRotationY/placement-rotation double-flip).
    if (primaryAction && ['locomotion_3d', 'vehicle', 'platformer', 'shooter'].includes(gameType)) {
      const snap2 = p.snapshot();
      const beforeP = p.pos(player);
      const beforeFwd = p.forward(player);
      // Real games gate behavior scripts on FSM gameplay state — the
      // FSM driver emits `active_behaviors` per state. For an automated
      // "could the user play this?" check we short-circuit the FSM and
      // force all behaviors on so onUpdate actually runs.
      p.activateAllBehaviors();
      try {
        p.keyDown(primaryAction);
        p.tickSeconds(1);
        p.keyUp(primaryAction);
        const afterP = p.pos(player);
        results.push(guarded('primary_action_responsive', () => {
          if (!beforeP || !afterP) return;
          const dx = afterP.x - beforeP.x, dy = afterP.y - beforeP.y, dz = afterP.z - beforeP.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 0.1) {
            // Iteration 7 audit improvement: instead of just declaring
            // "controls dead," probe the other common locomotion keys to
            // tell the author which key the controls ARE wired to. The
            // probe path only runs on FAILURE so the success path stays
            // fast; we snapshot+restore around each probe to keep player
            // state isolated.
            const probeKeys = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'MouseLeft'].filter(k => k !== primaryAction);
            const responsiveKeys: string[] = [];
            for (const k of probeKeys) {
              const probeSnap = p.snapshot();
              const probeBefore = p.pos(player);
              try {
                p.keyDown(k); p.tickSeconds(0.5); p.keyUp(k);
                const probeAfter = p.pos(player);
                if (probeBefore && probeAfter) {
                  const moved = Math.hypot(
                    probeAfter.x - probeBefore.x,
                    probeAfter.y - probeBefore.y,
                    probeAfter.z - probeBefore.z,
                  );
                  if (moved > 0.1) responsiveKeys.push(k);
                }
              } catch {}
              p.restore(probeSnap);
            }
            const hint = responsiveKeys.length > 0
              ? `Player did NOT move under "${primaryAction}" but DID under: ${responsiveKeys.join(', ')}. Fix the input binding so the advertised key matches the wired one.`
              : `Holding "${primaryAction}" for 1s moved player ${d.toFixed(3)} units, and probing the other common keys (${probeKeys.join(', ')}) didn't move the player either. Controls appear genuinely unwired — check the active behaviors / input bindings.`;
            throw new PlaytestFailure('controls_dead', hint,
              { primaryAction, moved: d, probedKeys: probeKeys, responsiveKeys });
          }
        }));
        // ── Mesh facing tracks dominant motion ──
        // After holding the primary action for 1s and moving a meaningful
        // distance, the mesh's visible forward axis should not be 180° out
        // of phase with the motion vector. Iteration 6's beat_em_up shipped
        // with `setRotationEuler(0, +90, 0)` for `_facing=+1` (right) on a
        // GLB whose intrinsic forward axis meant the model pointed AWAY
        // from movement. The user said "facing direction is opposite."
        //
        // The check is universal — every locomotion genre with a visible
        // character benefits. FPS and shooter strafe legitimately; for
        // those we relax via the dotThreshold below (only fail on near-
        // 180° anti-alignment, not mild misalignment from camera-relative
        // movement). Pure-UI / paddle / clicker games are skipped because
        // they don't have a "facing" concept.
        if (!isPureUI && gameType !== 'unknown') {
          results.push(guarded('mesh_facing_tracks_motion', () => {
            if (!beforeP || !afterP || !beforeFwd) return;
            // Skip rotationally-symmetric meshes — a sphere / ball has no
            // visible "facing" direction so the test is meaningless and
            // would false-positive on roll-a-ball / sonic-style games.
            const sceneNow: any = p.runtime.scene;
            const ent: any = sceneNow?.entities?.get(player.id);
            const tags: any = ent?.tags;
            const tagList: string[] = tags instanceof Set ? Array.from(tags) : (Array.isArray(tags) ? tags : []);
            if (tagList.includes('ball') || tagList.includes('orb') || tagList.includes('sphere')) return;
            const mr: any = ent?.getComponent?.('MeshRendererComponent');
            const meshType = (mr?.meshType ?? '').toLowerCase();
            if (meshType === 'sphere') return;
            const dx = afterP.x - beforeP.x, dz = afterP.z - beforeP.z;
            const speed = Math.sqrt(dx * dx + dz * dz);
            if (speed < 0.5) return;  // didn't move enough to judge
            const mx = dx / speed, mz = dz / speed;
            // Sample the CURRENT forward (post-tick), since most behaviours
            // rotate the mesh while movement is held. beforeFwd is the
            // pre-input rotation and would miss reactive facing.
            const afterFwd = p.forward(player) ?? beforeFwd;
            const dot = mx * afterFwd.x + mz * afterFwd.z;
            // FPS / shooter / locomotion may strafe — only fail on
            // near-anti-alignment. Vehicle / platformer / beat_em_up / rpg
            // / fighting all expect tight alignment.
            const strafeFriendly = (gameType === 'shooter' || gameType === 'locomotion_3d');
            const threshold = strafeFriendly ? -0.6 : -0.2;
            if (dot < threshold) {
              throw new PlaytestFailure('facing_anti_motion',
                `character mesh faces OPPOSITE the direction it moves when "${primaryAction}" is held ` +
                `(forward·motion = ${dot.toFixed(2)}; forward=(${afterFwd.x.toFixed(2)}, ${afterFwd.z.toFixed(2)}) ` +
                `motion=(${mx.toFixed(2)}, ${mz.toFixed(2)})). The user will see the model walking backwards. ` +
                `Usual cause: hand-rolled \`setRotationEuler(0, ±90, 0)\` with the wrong sign for the chosen GLB's ` +
                `intrinsic forward axis. Fix: replace the math with \`this.entity.transform.faceDirection(dx, dz)\` ` +
                `which uses the engine's canonical -Z forward and works on any GLB without per-asset tuning.`,
                { dot, forward: { x: afterFwd.x, z: afterFwd.z }, motion: { x: mx, z: mz }, gameType });
            }
          }));
        }
        // Motion-vs-facing for vehicles. Gated to vehicles because locomotion
        // / shooter games may strafe (move sideways or relative to a camera)
        // legitimately; the vehicle contract is tighter — throttle always
        // moves along the car's forward axis.
        if (gameType === 'vehicle') {
          results.push(guarded('motion_matches_forward', () => {
            if (!beforeP || !afterP || !beforeFwd) return;
            const dx = afterP.x - beforeP.x, dz = afterP.z - beforeP.z;
            const speed = Math.sqrt(dx * dx + dz * dz);
            if (speed < 0.5) return;  // didn't move enough to judge
            const mx = dx / speed, mz = dz / speed;
            const dot = mx * beforeFwd.x + mz * beforeFwd.z;
            if (dot < -0.3) {
              throw new PlaytestFailure('backwards_motion',
                `vehicle moves OPPOSITE the direction its transform faces ` +
                `(motion·forward = ${dot.toFixed(2)}; forward=(${beforeFwd.x.toFixed(2)}, ${beforeFwd.z.toFixed(2)}) ` +
                `motion=(${mx.toFixed(2)}, ${mz.toFixed(2)})). ` +
                `The script's per-frame motion math is 180° out of phase with the transform's rotation. ` +
                `Usual cause: the script hard-codes a _heading default (e.g. 180) that doesn't match the placement's rotation Y. ` +
                `Fix: either init _heading = 0 and rely on the placement rotation, OR read the placement's yaw via ` +
                `this.entity.transform.getRotationEuler().y in onStart. Don't set modelRotationY — 3D assets are already ` +
                `normalized to a canonical frame; modelRotationY should be 0 or omitted.`,
                { dot, forward: beforeFwd, motion: { x: mx, z: mz } });
            }
          }));
        }
      } catch (e: any) {
        if (e instanceof PlaytestFailure) results.push({ name: 'primary_action_responsive', failure: e });
        else results.push({ name: 'primary_action_responsive', failure: new PlaytestFailure('tick_crash', String(e?.message ?? e)) });
      }
      p.restore(snap2);
    }
  }

  // ── 6. Camera for 3D games ──
  if (['locomotion_3d', 'vehicle', 'platformer', 'shooter', 'third_person', 'first_person'].includes(gameType)) {
    results.push(guarded('camera_exists', () => {
      const cam = discoverCamera(p);
      if (!cam) throw new PlaytestFailure('no_camera', 'no camera entity (no "camera" tag, no CameraComponent on any entity)', { hint: 'Define a camera prefab with `camera: { fov: 60 }` in 02_entities.json and place it in 03_worlds.json.' });
    }));
  }

  // ── 7. UI has at least one clickable element for truly UI-only games ──
  // Narrowed to gameType in {ui, clicker} only. Previously also fired on
  // paddle_2d (pong/breakout) and board (chess/tictac), which forced the CLI
  // to bolt a meaningless MENU / Restart button onto the gameplay HUD to
  // satisfy the check — they don't need clickables DURING play, their UI is
  // the score display. Those genres still have clickables in main_menu /
  // game_over states which we don't need to gate here because the main_menu
  // state is already reached and UI is verified visible via the advertised-
  // keys-resolve / cursor invariants.
  if (['ui', 'clicker'].includes(gameType)) {
    results.push(guarded('ui_has_interactable', () => {
      // First: runtime check — a button is currently visible. Cheap and
      // covers games where the playtest reaches a clickable state in 5 ticks.
      const btns = p.runtime.ui.listVisible().filter(el => el.kind === 'button' || el.kind === 'textInput');
      if (btns.length > 0) return;
      // Fallback: static reachability — scan the flow for any state that
      // opens an HTML panel containing clickable elements. A TD game's
      // playtest can still be in boot/main_menu at tick 5 even though its
      // gameplay state opens hud/td_hud which has tower-build buttons.
      // Without this fallback we false-fail and force the agent to add a
      // bogus button to satisfy the check.
      const flow = p.runtime.files.flow;
      const uiHtmls: Record<string, string> = p.runtime.files.uiHtmls ?? {};
      const panelHasClickable = (panelKey: string): boolean => {
        // Try a few key shapes — the runtime stores HTML by file path; the
        // flow's `show_ui:foo/bar` references the panel without the .html
        // suffix and with a leading "ui/" prefix in some places.
        const candidates = [
          panelKey,
          panelKey + '.html',
          'ui/' + panelKey,
          'ui/' + panelKey + '.html',
        ];
        for (const k of candidates) {
          const html = uiHtmls[k];
          if (typeof html === 'string' && /<button\b|onclick\s*=|role\s*=\s*["']button|cursor\s*:\s*pointer/i.test(html)) return true;
        }
        return false;
      };
      const collectShowUiTargets = (state: any, out: Set<string>) => {
        if (!state || typeof state !== 'object') return;
        const actions: string[] = [];
        if (Array.isArray(state.on_enter)) actions.push(...state.on_enter);
        if (Array.isArray(state.on_update)) actions.push(...state.on_update);
        for (const a of actions) {
          if (typeof a !== 'string') continue;
          const m = a.match(/^show_ui:(.+)$/);
          if (m) out.add(m[1].trim());
        }
        if (state.substates && typeof state.substates === 'object') {
          for (const sub of Object.values(state.substates)) collectShowUiTargets(sub, out);
        }
      };
      const targets = new Set<string>();
      if (flow?.states && typeof flow.states === 'object') {
        for (const s of Object.values(flow.states)) collectShowUiTargets(s, targets);
      }
      for (const t of targets) {
        if (panelHasClickable(t)) return;
      }
      throw new PlaytestFailure('ui_unreachable',
        `gameType=${gameType} but no visible clickable UI element exists at playtest tick 5, AND no flow state opens an HTML panel containing clickable elements (scanned ${targets.size} show_ui target${targets.size === 1 ? '' : 's'}).`,
        { hint: 'Create at least one scene.createButton({ x, y, width, height, text, onClick }) in a system onStart, OR declare clickable UI (<button>, onclick=, role="button", cursor:pointer) in an HTML panel opened via show_ui from any flow state.', scannedShowUiTargets: Array.from(targets) });
    }));
  }

  // ── 8. FSM start state must resolve to a real state def ──
  if (p.runtime.files.flow?.start) {
    results.push(guarded('fsm_state_valid', () => {
      const startStateName: string = p.runtime.files.flow.start;
      if (!p.runtime.files.flow.states?.[startStateName]) {
        throw new PlaytestFailure('fsm_unreachable',
          `FSM start state "${startStateName}" has no definition in 01_flow.json.states`,
          { state: startStateName });
      }
    }));
  }

  // ── 8b. Pause state must be a substate of gameplay, not a sibling ──
  //
  // Driving run cc4f5f19 authored a flat FSM: `gameplay` and `paused` as
  // sibling top-level states. Resuming fired gameplay.on_enter which
  // emitted `race_start` — car teleports back to spawn every time the
  // player un-pauses. The five pinned templates that ship with a pause
  // (cellar_purge, buccaneer_bay, noodle_jaunt, court_clash, banner_siege)
  // all correctly nest `paused` as a substate of `gameplay` so on_enter
  // doesn't re-fire on resume. This invariant enforces that pattern.
  if (p.runtime.files.flow?.states) {
    const states: any = p.runtime.files.flow.states;
    const siblingPause = Object.keys(states).find(k => /^pause[ds]?$/i.test(k));
    if (siblingPause) {
      results.push({
        name: 'pause_state_is_substate_of_gameplay',
        failure: new PlaytestFailure('pause_at_root',
          `01_flow.json has a root-level state "${siblingPause}" for pausing. Going gameplay → paused → gameplay re-fires gameplay.on_enter every time the player resumes, which commonly resets the match (emit:game.race_start / match_started / restart_game). Move it INSIDE gameplay as a substate: \`"gameplay": { "start": "playing", "substates": { "playing": {...}, "paused": {...} } }\`. The pinned templates cellar_purge, buccaneer_bay, noodle_jaunt, court_clash, and banner_siege all follow this pattern — library.sh show cellar_purge/01_flow.json for reference.`,
          { pauseState: siblingPause, pattern: 'sibling pause state' }),
      });
    }
  }

  // ── 9. Advertised keys must actually DO something ──
  // Scans every ui/**/*.html for keybind hints (<span class="kbd">X</span>
  // followed by an action word, or "Press X" / "X to Y" patterns). For each
  // inferred key, simulates a tap and verifies SOME observable state
  // changed — FSM state, ui state-bag, or entity count. The P-pause bug in
  // run 84eeafa0 had ui_bridge emitting `keyboard:pause` into a void
  // because 01_flow.json had no pause state listening for it; this
  // invariant would have caught that.
  //
  // Skipped keys: movement (WASD/arrows) — already covered by
  // primary_action_responsive. MouseLeft/Right — handled via click().
  // Escape — owned by the browser's pointer-lock release, not the game.
  // Detection is STATIC — search for any subscriber that claims to
  // handle the key. Runtime simulation looked tempting but ran into two
  // unsolvable problems in practice:
  //   1. Games with continuously-mutating state (asteroid timers, score
  //      tickers) made "did anything change after the tap?" always true.
  //   2. Games whose pause wiring is inside a `gameplay` FSM state never
  //      exercised that wiring when the invariant ran in `main_menu`,
  //      producing false positives for LEGITIMATELY-alive keys like the
  //      clean_driving baseline's P pause.
  //
  // Static analysis dodges both: we look for any of
  //   • a script calling isKeyDown/isKeyPressed/isKeyUp with the key code
  //   • a flow transition whose `when` names the key's code or its
  //     inferred action (e.g. "P to pause" → search for "keyboard:pause",
  //     "input:KeyP", "input:pause")
  // Dead only if NOTHING claims the key across all scripts and all
  // transitions in the flow (including nested substates).
  //
  // The asteroid run c685f774 has "P to pause" in its HUD but no script
  // reads KeyP and no flow transition watches `keyboard:pause` —
  // correctly dead. The clean_driving baseline has a
  // `when: "keyboard:pause"` transition inside `driving` state —
  // correctly alive.
  const uiHtmls = p.runtime.files.uiHtmls ?? {};
  if (Object.keys(uiHtmls).length > 0) {
    const SKIP_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'MouseLeft', 'MouseRight', 'MouseMiddle', 'Escape', 'Tab']);
    const deadKeys: Array<{ key: string; source: string; context: string }> = [];
    const seen = new Set<string>();
    const scripts = p.runtime.projectScripts ?? {};
    const flow = p.runtime.files.flow;

    // Flatten all transitions across the flow tree (including substates).
    const allTransitions: Array<{ when: string }> = [];
    const walkStates = (states: any): void => {
      for (const def of Object.values<any>(states ?? {})) {
        for (const t of (def?.transitions ?? [])) {
          if (typeof t?.when === 'string') allTransitions.push({ when: t.when });
        }
        if (def?.substates) walkStates(def.substates);
      }
    };
    walkStates(flow?.states);

    for (const [sourcePath, html] of Object.entries<string>(uiHtmls)) {
      const hints = extractKeyHints(html);
      for (const hint of hints) {
        const code = keyLabelToCode(hint.key);
        if (!code || SKIP_KEYS.has(code) || seen.has(code)) continue;
        seen.add(code);

        // Derive the action name from the hint context ("P to pause" → "pause",
        // "Esc to exit" → "exit"). Falls back to empty string if the context
        // has no recognisable verb after the key.
        const contextRest = hint.context.replace(new RegExp(`^${hint.key}\\s+(to\\s+)?`, 'i'), '').trim();
        const action = contextRest.split(/\s+/)[0]?.toLowerCase() ?? '';

        // 1) Check script sources for direct key polling. Exclude
        // `systems/ui/ui_bridge.ts` and similar UI transport shims —
        // those universally read KeyP / Esc / MouseLeft and emit
        // `keyboard:<action>` / `ui_event:<panel>:<action>` events,
        // acting as pass-throughs. Their existence says nothing about
        // whether the game actually wires the action; the test has to
        // see a FLOW transition or a GAMEPLAY script for that. Asteroid
        // run c685f774 shipped the boilerplate ui_bridge with the
        // `KeyP → keyboard:pause` emit, but its 01_flow.json had no
        // pause state — the emit went into a void and P was effectively
        // dead. Excluding the transport layer preserves that catch.
        const keyRe = new RegExp(`is(Key|Button)(Down|Pressed|Up)\\s*\\(\\s*["']${code}["']`);
        let hasScriptHandler = false;
        // The assembler flattens project paths via underscores, so
        // `systems/ui/ui_bridge.ts` becomes `scripts/ui_ui_bridge.ts`
        // in runtime.projectScripts. The skiplist pattern has to match
        // either shape — hence the optional directory prefix.
        const TRANSPORT_RE = /(^|[\/_])(ui_bridge|mp_bridge|fsm_driver|_entity_label|event_definitions|_event_validator)(_[^/]*)?\.ts$/;
        for (const [scriptPath, src] of Object.entries(scripts)) {
          if (TRANSPORT_RE.test(scriptPath)) continue;
          if (keyRe.test(src)) { hasScriptHandler = true; break; }
        }

        // 2) Check flow transitions for a `when` clause that matches.
        let hasFlowHandler = false;
        for (const t of allTransitions) {
          const w = t.when;
          if (w === `input:${code}`) { hasFlowHandler = true; break; }
          if (action && (w === `keyboard:${action}` || w === `input:${action}`)) {
            hasFlowHandler = true; break;
          }
        }

        if (!hasScriptHandler && !hasFlowHandler) {
          deadKeys.push({ key: code, source: sourcePath, context: hint.context });
        }
      }
    }
    if (deadKeys.length > 0) {
      results.push({
        name: 'advertised_keys_resolve',
        failure: new PlaytestFailure('advertised_key_dead',
          `HUD advertises key${deadKeys.length > 1 ? 's' : ''} that do nothing when pressed: ${deadKeys.map(d => `"${d.key}" (${d.context})`).join(', ')}. Either wire it in 01_flow.json as a transition (e.g. ui_event:panel:action OR a custom event name matched by an active system), or remove the hint from the HUD HTML.`,
          { deadKeys }),
      });
    } else if (seen.size > 0) {
      results.push({ name: 'advertised_keys_resolve', failure: null });
    }
  }

  // ── 10. Interactive entities must have colliders ──
  // Two detection paths, either fires:
  //   (a) name-based: the entity's name matches a gameplay-suggestive
  //       vocabulary (wall, ramp, pickup, enemy, asteroid, ...). Low false
  //       positive risk — if you named it a wall, it had better collide.
  //   (b) shape-based: the entity has a visible MeshRenderer with a
  //       volumetric mesh (cube or custom GLB) placed in the world, AND
  //       no ColliderComponent. The mesh being custom/cube AND placed
  //       suggests it's solid geometry the player is meant to interact
  //       with; a plane (floor/decal) is excluded because planes can
  //       legitimately be non-collidable (HUD quad, skybox strip).
  //
  // `decoration_only` / `no_collide` tags are escape hatches for
  // intentionally non-collidable meshes.
  results.push(guarded('interactive_entities_have_colliders', () => {
    // Name matching uses word boundaries — catches `platform_large`,
    // `big_wall`, `concrete_wall_tall`, `enemy_drone`, etc. — without
    // maintaining parallel prefix/suffix wildcard lists. Platformer run
    // 3c887c49 shipped with `platform_large/_medium/_small` definitions
    // that had NO physics block; the old exact-match regex only
    // matched bare `platform`, so all three variants slipped through
    // and the player fell into them at spawn.
    const INTERACTIVE_NAME_RE = /\b(wall|ramp|fence|boundary|barrier|obstacle|pickup|coin|collectable|collectible|hazard|enemy|pillar|platform|block|brick|stair|floor|rock|asteroid|boulder|door|gate|potion|apple|shield|crate|barrel|shelf|bumper|bomb|mine|tower|turret|zombie|robot|goomba|orc|goblin|skeleton|slime|drone|ufo|ship|target|flag|checkpoint|gem|crystal|orb|cookie|powerup|spike|lava)\b/i;
    const scene: any = p.runtime.scene;
    if (!scene) return;
    const missing: Array<{ name: string; reason: string }> = [];
    for (const e of scene.entities.values()) {
      if (!e.active) continue;
      // Centralised decoration check — covers decoration_only/no_collide/vfx/
      // particle/backdrop/background/effect tags. Iteration 7 audit moved
      // this in front of the name-regex match so a `Spotlight Pillar`
      // tagged decoration_only doesn't get flagged just for matching `pillar`.
      if (isDecorative(e)) continue;
      const tags = e.tags instanceof Set ? Array.from(e.tags) : (Array.isArray(e.tags) ? e.tags : []);
      if (tags.includes('ui') || tags.includes('camera')) continue;
      // System host entities (system_<name> tag) are bookkeeping shells
      // for system scripts, not collidable game-world objects.
      if (tags.some((t: any) => typeof t === 'string' && t.startsWith('system_'))) continue;
      const cc = e.getComponent('ColliderComponent');
      if (cc) continue;  // already has one — fine
      const nameMatches = INTERACTIVE_NAME_RE.test(e.name);
      // Shape-based check (b): volumetric mesh, placed in world, no collider.
      let shapeSuspect = false;
      if (!nameMatches) {
        const mr: any = e.getComponent('MeshRendererComponent');
        if (mr && mr.gpuMesh) {
          // meshType can be "custom" (GLB), "cube", "sphere", "capsule",
          // "cylinder", "cone", "plane", "empty". Treat volumetric
          // primitives + custom as solids worth flagging; plane/empty are
          // usually legitimate as non-colliders.
          const mt = (mr.meshType || '').toLowerCase();
          if (mt === 'custom' || mt === 'cube' || mt === 'sphere' || mt === 'cylinder' || mt === 'cone' || mt === 'capsule') {
            shapeSuspect = true;
          }
        }
      }
      if (nameMatches) {
        missing.push({ name: e.name, reason: 'interactive name, no collider' });
      } else if (shapeSuspect) {
        missing.push({ name: e.name, reason: 'volumetric mesh placed in world, no collider' });
      }
    }
    if (missing.length > 0) {
      // Aggregation pass: when the offender list is large, cluster names by
      // the first one or two whitespace-separated words so a forest of
      // "Spotlight Pillar 1/2/3/..." entries collapses to one summary line.
      const NAME_PREFIX_RE = /^(\w+(?:\s+\w+)?)/;
      const aggregateNames: string[] = [];
      if (missing.length > 6) {
        const histogram = new Map<string, number>();
        for (const m of missing) {
          const pm = m.name.match(NAME_PREFIX_RE);
          const prefix = pm ? pm[1] : m.name;
          histogram.set(prefix, (histogram.get(prefix) ?? 0) + 1);
        }
        for (const [prefix, count] of histogram.entries()) {
          if (count >= 4) aggregateNames.push(`${count}x ${prefix}* (interactive name, no collider)`);
        }
      }
      const individuals = missing.slice(0, 5).map(m => `"${m.name}" (${m.reason})`);
      const remaining = missing.length - 5;
      const moreInline = remaining > 0 && aggregateNames.length === 0 ? ` (+${remaining} more)` : '';
      const names = individuals.join(', ') + moreInline + (aggregateNames.length > 0 ? `; ${aggregateNames.join(', ')}` : '');
      throw new PlaytestFailure('interactive_no_collider',
        `${missing.length} entit${missing.length > 1 ? 'ies' : 'y'} look interactive (by name pattern) but have no collider: ${names}. ` +
        `If these are non-interactive backdrop / decoration / effect props, add tag "decoration_only" in 02_entities.json so they're skipped from collision and pickup checks. ` +
        `Only add a physics block if the player is meant to bump into them (e.g. \`physics: { type: "static", collider: "box" }\` for walls/obstacles, \`physics: { type: "static", collider: { shape: "box" }, is_trigger: true }\` for pickups/zones).`,
        { missing: missing.slice(0, 10), total: missing.length, aggregated: aggregateNames });
    }
  }));

  // ── 10b. Static-rigidbody entities must not move during play. ──
  //
  // Caught the platformer template's `moving_platform` having no physics
  // block (so level_assembler defaulted it to STATIC). PlatformerLevelSystem
  // then drove its transform via scene.setPosition every frame; the static
  // collider got teleported under the player via rb.teleport, but the
  // engine's carryKinematicRiders only iterates KINEMATIC bodies, so the
  // player was never registered as a rider and never translated by the
  // platform's per-frame delta — symptom: "have to walk to stay on it."
  //
  // Detection: snapshot static-RB positions after a brief settle (so
  // boot-time placement adjustments don't trip us), activate behaviors,
  // tick ~1.5s, flag anything that drifted. Threshold 0.05m is well
  // above Rapier's resting-contact jitter for static bodies (which is
  // effectively zero) but small enough to catch any continuously-moved
  // platform.
  results.push(guarded('static_bodies_dont_move', () => {
    const scene: any = p.runtime.scene;
    if (!scene) return;
    // BodyType.STATIC === 0 (engine/shared/types/physics_enums.ts).
    const STATIC = 0;
    type Snap = { x: number; y: number; z: number; name: string };
    const snap = (): Map<number, Snap> => {
      const m = new Map<number, Snap>();
      for (const e of scene.entities.values()) {
        if (!e.active) continue;
        const rb: any = e.getComponent('RigidbodyComponent');
        if (!rb || rb.bodyType !== STATIC) continue;
        const tc: any = e.getComponent('TransformComponent');
        if (!tc) continue;
        m.set(e.id, { x: tc.position.x, y: tc.position.y, z: tc.position.z, name: e.name });
      }
      return m;
    };
    // Brief settle, then sample, then run.
    try { p.tick(10); } catch {}
    const before = snap();
    p.activateAllBehaviors();
    try { p.tick(90); } catch {}
    const moved: Array<{ name: string; dist: number }> = [];
    for (const [id, prev] of before) {
      const e = scene.entities.get(id);
      if (!e) continue;
      const tc: any = e.getComponent('TransformComponent');
      if (!tc) continue;
      const dx = tc.position.x - prev.x;
      const dy = tc.position.y - prev.y;
      const dz = tc.position.z - prev.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > 0.05) moved.push({ name: prev.name, dist });
    }
    if (moved.length > 0) {
      moved.sort((a, b) => b.dist - a.dist);
      const top = moved.slice(0, 5).map(m => `"${m.name}" (drifted ${m.dist.toFixed(2)}m)`).join(', ');
      const more = moved.length > 5 ? ` (+${moved.length - 5} more)` : '';
      throw new PlaytestFailure('static_body_moved',
        `${moved.length} static-rigidbody entit${moved.length > 1 ? 'ies' : 'y'} had ${moved.length > 1 ? 'their' : 'its'} position changed during play: ${top}${more}. ` +
        `Static bodies can't carry riders — physics_system.ts \`carryKinematicRiders\` only iterates KINEMATIC bodies, so the player won't ride a moving platform and other dynamic objects won't react to the moving collider's velocity. ` +
        `Set \`physics: { type: "kinematic" }\` on these entities in 02_entities.json so the engine drives them via setNextKinematicTranslation and translates riders by the per-frame delta.`,
        { moved: moved.slice(0, 10), total: moved.length });
    }
  }));

  // ── 11. Pickup-tagged entities must despawn or fire an event when the player overlaps ──
  // Sonic bug: coin_pickup entity existed, player could reach it, but nothing
  // handled pickup — no behavior attached, no FSM event. This runs one probe:
  // find the first pickup, teleport the player on top of it, tick a few
  // frames, verify either the pickup entity is gone OR a pickup-like event
  // fired.
  //
  // Generalizes over static + dynamic spawns: if no pickups are present at
  // boot, tick 3 seconds to let any spawner system fire, then re-scan.
  // Also uses an expanded pickup vocabulary matching the enemy/pickup list
  // in the collider invariant.
  // Tightened in iteration 7 audit: the original regex matched any entity
  // whose NAME merely STARTED with `apple|cookie|orb|mushroom|flower|sun_blob|...`,
  // which false-positively swept up backdrop props (an `apple_tree` decoration
  // is not a pickup). Now we require either an explicit pickup-shaped suffix
  // OR a single-word pickup name plus a pickup/collectible tag.
  const PICKUP_SUFFIX_RE = /(_pickup|_coin|_gem|_collectible|_powerup|_health_pack)$/i;
  const PICKUP_TAG_NAMES = /^(coin|gem|pickup|collectible|powerup|crystal|shard|key|orb)$/i;
  function looksLikePickup(name: string, def: any): boolean {
    if (PICKUP_SUFFIX_RE.test(name)) return true;
    // Single-word pickup-y names only if the entity carries a pickup-shaped tag.
    if (PICKUP_TAG_NAMES.test(name)) {
      const tags = def?.tags;
      const list: string[] = tags instanceof Set ? Array.from(tags) : (Array.isArray(tags) ? tags : []);
      if (list.some((t: any) => typeof t === 'string' && /pickup|collectible|coin|gem/i.test(t))) return true;
    }
    return false;
  }
  const findPickups = () => [...(p.runtime.scene?.entities.values() ?? [])].filter((e: any) => {
    if (!e.active) return false;
    // Decoration-tagged entities (backdrop trees, vfx particles, etc.) must
    // NOT be probed as pickups even if their name looks pickup-shaped.
    if (isDecorative(e)) return false;
    if (looksLikePickup(e.name, e)) return true;
    if (e.tags instanceof Set) {
      return e.tags.has('pickup') || e.tags.has('coin') || e.tags.has('collectable') || e.tags.has('collectible') || e.tags.has('gem') || e.tags.has('powerup');
    }
    if (Array.isArray(e.tags)) {
      return e.tags.some((t: string) => ['pickup', 'coin', 'collectable', 'collectible', 'gem', 'powerup'].includes(t));
    }
    return false;
  });
  if (player) {
    let pickups = findPickups();
    if (pickups.length === 0) {
      // No pre-placed pickups — wait for a spawner to run. Most spawners
      // gate themselves on `active_behaviors` which we toggled above, so
      // 3 seconds of ticks (180 frames) usually gives them time to fire.
      const snap = p.snapshot();
      try {
        p.activateAllBehaviors();
        p.tickSeconds(3);
        pickups = findPickups();
      } catch {}
      p.restore(snap);
    }
    if (pickups.length > 0) {
      const snap = p.snapshot();
      const pickup = pickups[0];
      const pickupRef = { id: pickup.id, name: pickup.name };
      const pickupPos = p.pos(pickupRef);
      if (pickupPos) {
        const sinceFrame = p.frameCount();
        try {
          p.activateAllBehaviors();
          p.teleport(player, pickupPos);
          p.tick(10);
          const stillThere = !!p.runtime.scene?.entities.get(pickup.id) && !!p.runtime.scene?.entities.get(pickup.id)?.active;
          const PICKUP_EVENT_RE = /(coin|pickup|collect|score|gem|crystal|powerup|star)/i;
          const pickupEvents = p.eventsFired({ sinceFrame }).filter(e => PICKUP_EVENT_RE.test(e.name));
          if (stillThere && pickupEvents.length === 0) {
            results.push({
              name: 'pickup_despawns_on_overlap',
              failure: new PlaytestFailure('pickup_inert',
                `pickup "${pickup.name}" didn't despawn or fire any pickup-like event after the player stood on it for 10 frames. The entity looks like a pickup (by name/tag) but nothing handles collection — probably missing a behavior like \`pickup\`/\`collect_on_touch\` on the entity def in 02_entities.json, or the pickup system isn't listed in 01_flow.json's active_behaviors for the gameplay state.`,
                { pickup: pickup.name, position: pickupPos }),
            });
          } else {
            results.push({ name: 'pickup_despawns_on_overlap', failure: null });
          }
        } catch (e: any) {
          results.push({ name: 'pickup_despawns_on_overlap', failure: e instanceof PlaytestFailure ? e : new PlaytestFailure('tick_crash', String(e?.message ?? e)) });
        }
        p.restore(snap);
      }
    }
  }

  // ── 12. Gameplay state with clickable UI must show the cursor ──
  // Two failure modes this catches:
  //   (a) static: any gameplay-phase state has show_ui: in on_enter but no
  //       show_cursor (and no deliberate hide_cursor). Classic pattern.
  //   (b) dynamic: after boot + settle, the scene-level UI actually has
  //       visible clickable elements (buttons / text inputs), meaning the
  //       game relies on scene.createButton OR opened a panel from a
  //       system onStart, AND every non-boot state's on_enter lacks
  //       show_cursor. Catches the pong/clicker/tic-tac-toe pattern where
  //       the CLI drew a "Restart" button via scene.createButton straight
  //       from the gameplay system — those buttons exist, the virtual
  //       cursor is the only way to click them, but no flow state ever
  //       enables the cursor.
  const flow: any = p.runtime.files.flow;
  if (flow?.states) {
    const cursorlessClickableStates: Array<{ state: string; reason: string }> = [];
    let anyStateShowsCursor = false;
    // Iteration 7 audit improvement: walk substates with PARENT cursor
    // inheritance — a substate inherits the parent's show_cursor unless it
    // explicitly contains hide_cursor. Without inheritance, a child
    // gameplay substate that opens a UI panel would false-flag even when
    // the parent's on_enter already enables the cursor.
    const walkCursorStates = (stateName: string, stateDef: any, inheritedShowCursor: boolean): void => {
      if (stateName === 'boot') {
        // Still recurse into substates so any nested gameplay states are checked.
        for (const [sn, sd] of Object.entries<any>(stateDef?.substates ?? {})) {
          walkCursorStates(sn, sd, inheritedShowCursor);
        }
        return;
      }
      const onEnter: string[] = Array.isArray(stateDef?.on_enter) ? stateDef.on_enter : [];
      const opensUI = onEnter.some(op => typeof op === 'string' && /^show_ui:/.test(op));
      const ownShowCursor = onEnter.some(op => typeof op === 'string' && /^show_cursor\b/.test(op));
      const ownHideCursor = onEnter.some(op => typeof op === 'string' && /^hide_cursor\b/.test(op));
      const effectiveShowCursor = ownHideCursor ? false : (ownShowCursor || inheritedShowCursor);
      if (ownShowCursor || inheritedShowCursor) anyStateShowsCursor = true;
      if (opensUI && !effectiveShowCursor && !ownHideCursor) {
        cursorlessClickableStates.push({ state: stateName, reason: 'opens UI but no show_cursor in on_enter (or any ancestor)' });
      }
      for (const [sn, sd] of Object.entries<any>(stateDef?.substates ?? {})) {
        walkCursorStates(sn, sd, effectiveShowCursor);
      }
    };
    for (const [stateName, stateDef] of Object.entries<any>(flow.states)) {
      walkCursorStates(stateName, stateDef, false);
    }
    // Dynamic check: are there scene-level clickables that need a cursor
    // but no state ever enables one?
    const visibleClickables = p.runtime.ui.listVisible().filter(el =>
      el.kind === 'button' || el.kind === 'textInput' || el.kind === 'slider' || el.kind === 'dropdown');
    if (visibleClickables.length > 0 && !anyStateShowsCursor) {
      cursorlessClickableStates.push({
        state: '(any gameplay state)',
        reason: `${visibleClickables.length} clickable UI element(s) were created via scene.createButton / createTextInput but no flow state calls show_cursor — the user has buttons they cannot reach. This commonly happens when the CLI draws Restart / shop / menu buttons from a gameplay system via scene.createButton instead of declaring them in an HTML panel + show_ui:. Fix path A: use show_ui:<panel> with the buttons in an HTML panel. Fix path B: add "show_cursor" to at least one state's on_enter.`,
      });
    }
    if (cursorlessClickableStates.length > 0) {
      results.push({
        name: 'cursor_visible_during_clickable_ui',
        failure: new PlaytestFailure('cursor_gated_off',
          `state${cursorlessClickableStates.length > 1 ? 's' : ''} ${cursorlessClickableStates.map(s => `"${s.state}"`).join(', ')} have clickable UI but no show_cursor is called — the virtual cursor isn't visible and the user can't click the buttons. ${cursorlessClickableStates[0].reason}`,
          { states: cursorlessClickableStates }),
      });
    }
  }

  // ── 13. hud_update must stop after the end-of-match event ──
  // Driving / asteroid bug: score flickers between two values on the
  // game-over screen because the live-HUD system keeps emitting hud_update
  // while the game-over modal animates a final score. Both write the same
  // DOM element and fight.
  //
  // Try a handful of end-event names — games don't always use `game_over`;
  // common variants from the baseline event list include match_ended /
  // victory / defeat / game_won / round_ended. If ANY of them triggers
  // score-key-flicker, flag. Single fail is enough.
  const END_EVENTS = ['game_over', 'match_ended', 'victory', 'defeat', 'game_won', 'round_ended', 'round_complete', 'level_complete'];
  const SCORE_LIKE_KEY_RE = /(score|points?|coins?|kills?|streak|combo|gems?|rank)/i;
  if (player) {
    let flickerDetected: { endEvent: string; count: number; sampleKeys: string[] } | null = null;
    for (const endEvent of END_EVENTS) {
      if (flickerDetected) break;
      const snap = p.snapshot();
      try {
        p.activateAllBehaviors();
        // Iteration 7 audit fix: count only score-keyed values that ACTUALLY
        // CHANGED post-game-over, not raw emit volume. A live HUD that keeps
        // emitting `{ score: 42 }` every frame after the match ends doesn't
        // flicker — only one that emits `{ score: 41 }, { score: 42 }, …`
        // (or different writers fighting over the same key) does. Track the
        // last value per score-key and increment a counter only on diffs.
        const gameOverFrame = p.frameCount();
        if (p.runtime.scriptScene?.events?.game?.emit) {
          p.runtime.scriptScene.events.game.emit(endEvent, {});
        }
        // Pre-game-over baseline: last value seen per score-keyed key from
        // the events emitted BEFORE we fired the end event.
        const lastScoreValues = new Map<string, any>();
        const preEnd = p.eventsFired({ channel: 'ui', name: 'hud_update' }).filter(e => e.frame <= gameOverFrame);
        for (const ev of preEnd) {
          const d = ev.data;
          if (!d || typeof d !== 'object') continue;
          for (const k of Object.keys(d)) {
            if (SCORE_LIKE_KEY_RE.test(k)) lastScoreValues.set(k, d[k]);
          }
        }
        p.tick(30);
        const post = p.eventsFired({ channel: 'ui', name: 'hud_update', sinceFrame: gameOverFrame + 1 });
        let changedScoreUpdates = 0;
        const sampleKeysSet = new Set<string>();
        const eq = (a: any, b: any): boolean => {
          if (a === b) return true;
          if (a && typeof a === 'object' && b && typeof b === 'object') {
            try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
          }
          return false;
        };
        for (const ev of post) {
          const d = ev.data;
          if (!d || typeof d !== 'object') continue;
          for (const k of Object.keys(d)) {
            if (!SCORE_LIKE_KEY_RE.test(k)) continue;
            const prev = lastScoreValues.get(k);
            if (!eq(prev, d[k])) {
              changedScoreUpdates++;
              sampleKeysSet.add(k);
              lastScoreValues.set(k, d[k]);
            }
          }
        }
        if (changedScoreUpdates >= 3) {
          flickerDetected = {
            endEvent,
            count: changedScoreUpdates,
            sampleKeys: Array.from(sampleKeysSet),
          };
        }
      } catch {}
      p.restore(snap);
    }
    if (flickerDetected) {
      results.push({
        name: 'hud_stops_after_game_over',
        failure: new PlaytestFailure('hud_keeps_updating',
          `${flickerDetected.count} score-keyed \`ui.hud_update\` value${flickerDetected.count > 1 ? 's' : ''} CHANGED AFTER \`${flickerDetected.endEvent}\` — the HUD system keeps pushing fresh score values while the end-screen modal animates a final score to the same DOM element. The two writes fight and the display flickers. Fix: in the gameplay system, listen for \`${flickerDetected.endEvent}\` (or whichever end event your game uses) and set \`this._ended = true\`, then guard the hud_update emission with \`if (this._ended) return;\`. Non-score keys (speed, gear, health) don't flicker and can keep emitting.`,
          {
            endEvent: flickerDetected.endEvent,
            postEndChangedUpdates: flickerDetected.count,
            sampleKeys: flickerDetected.sampleKeys,
          }),
      });
    } else {
      results.push({ name: 'hud_stops_after_game_over', failure: null });
    }
  }

  // ── 14. Replay consistency — core mechanics work on 2nd playthrough ──
  // Driving bug (run 7f18dbfa): behaviors set per-instance state like
  // `_collected = true` in onStart only, which runs once per scene load.
  // FSM restart re-activates behaviors but doesn't re-call onStart. Second
  // playthrough = every coin already "collected" and un-pickable.
  // Probe: restart via scene-level `restart_game` event, re-run the pickup
  // check, verify pickup still despawns.
  //
  // Uses the same pickup-discovery + dynamic-spawner-wait as the pickup
  // invariant above so dynamically-spawned coins count.
  if (player) {
    let pickups2 = findPickups();
    if (pickups2.length < 2) {
      const snap0 = p.snapshot();
      try {
        p.activateAllBehaviors();
        p.tickSeconds(3);
        pickups2 = findPickups();
      } catch {}
      p.restore(snap0);
    }
    if (pickups2.length >= 2) {
      const snap = p.snapshot();
      try {
        p.activateAllBehaviors();
        // First playthrough: collect one pickup
        const first = pickups2[0];
        const firstPos = p.pos({ id: first.id, name: first.name });
        if (firstPos) {
          p.teleport(player, firstPos);
          p.tick(10);
        }
        // Simulate restart_game (every well-built game's reset event).
        if (p.runtime.scriptScene?.events?.game?.emit) {
          p.runtime.scriptScene.events.game.emit('restart_game', {});
        }
        p.tick(5);
        const sinceFrame = p.frameCount();
        // Second playthrough: try to collect DIFFERENT pickup. If it doesn't
        // despawn, behavior state is sticky across restart.
        const second = pickups2[1];
        const secondPos = p.pos({ id: second.id, name: second.name });
        if (secondPos) {
          p.teleport(player, secondPos);
          p.tick(10);
          const stillThere = !!p.runtime.scene?.entities.get(second.id) && !!p.runtime.scene?.entities.get(second.id)?.active;
          const PICKUP_EVENT_RE = /(coin|pickup|collect|score)/i;
          const events = p.eventsFired({ sinceFrame }).filter(e => PICKUP_EVENT_RE.test(e.name));
          if (stillThere && events.length === 0) {
            results.push({
              name: 'replay_pickup_still_works',
              failure: new PlaytestFailure('replay_broken',
                `pickup "${second.name}" stopped working after \`restart_game\` fired — per-instance behavior state (\`_collected\`, \`_consumed\`, \`_triggered\`) is sticky across replays because onStart runs once per scene load, not per gameplay session. Add a \`scene.events.game.on("restart_game", () => { this._collected = false; })\` listener in onStart, so the flag resets on replay.`,
                { pickup: second.name, position: secondPos }),
            });
          } else {
            results.push({ name: 'replay_pickup_still_works', failure: null });
          }
        }
      } catch {
        // Non-fatal if restart_game isn't handled — just skip this check.
      }
      p.restore(snap);
    }
  }

  // ── 15. FPS / shooter games must hide the player's own mesh ──
  // Run 502bd348: FPS warehouse game put a full Soldier_Male.glb on the
  // player entity with no hideFromOwner flag, so the player saw their own
  // body from inside the head. Engine now supports MeshRendererComponent
  // hideFromOwner=true (see mesh_renderer_component.ts); this invariant
  // forces the CLI to set it for camera-on-player FPS setups.
  // Iteration 7 audit fix: third-person shooters legitimately keep the player
  // mesh visible (the player needs to see their own avatar). Restrict the
  // check to gameType==='first_person' OR a shooter where the camera is
  // actually positioned on the player's head. For any other shooter we skip
  // entirely with a clear reason — own-mesh visibility is intentional there.
  const cameraIsOnPlayerHead = (player: EntityRef): boolean => {
    const cam = discoverCamera(p);
    if (!cam) return false;
    const camPos = p.pos(cam);
    const playerPos = p.pos(player);
    if (!camPos || !playerPos) return false;
    const horizontal = Math.hypot(camPos.x - playerPos.x, camPos.z - playerPos.z);
    const vertical = Math.abs(camPos.y - playerPos.y);
    return vertical < 1.5 && horizontal < 1.0;
  };
  if (gameType === 'first_person' || gameType === 'shooter') {
    if (player) {
      const onHead = gameType === 'first_person' ? true : cameraIsOnPlayerHead(player);
      if (!onHead) {
        results.push({
          name: 'fps_hides_own_mesh',
          failure: null,
          skipped: true,
          skipReason: 'third-person camera or non-FPS shooter — own-mesh visibility is intentional',
        });
      } else {
        const playerE: any = p.runtime.scene?.entities.get(player.id);
        const mr: any = playerE?.getComponent('MeshRendererComponent');
        if (mr && mr.meshAsset && !mr.hideFromOwner) {
          // Rule: a player-tagged entity with a visible mesh in an FPS-style
          // setup (gameType=first_person, OR shooter with camera on head)
          // must set hideFromOwner. The earlier check required the camera
          // to be a scene-graph descendant of the player — but the common
          // pattern is a SEPARATE camera entity with a behavior (fps_camera)
          // that snaps to the player's position every frame. The runtime
          // head-position check above catches that pattern without needing
          // the parent relationship in the scene graph.
          results.push({
            name: 'fps_hides_own_mesh',
            failure: new PlaytestFailure('own_mesh_visible',
              `player entity "${playerE.name}" has a visible mesh (asset=${mr.meshAsset}) but \`hideFromOwner\` is not set. In a ${gameType} game the camera sits at the player's head — the player sees their own model's interior, elbows, and neck stump. Fix: add \`hideFromOwner: true\` to the player entity's mesh data in 02_entities.json:\n    "mesh": { "type": "custom", "asset": "${mr.meshAsset}", "hideFromOwner": true }\nOther cameras (spectator, multiplayer peer views) still see the mesh — the flag only hides from the owning camera.`,
              { playerMesh: mr.meshAsset, player: playerE.name, gameType }),
          });
        }
      }
    }
  }

  // ── 16. Scene-drawn buttons are an anti-pattern when HTML panels exist ──
  // Clicker / pong / tic-tac-toe bug: CLI drew "Restart", "Click Cookie",
  // "Buy grandma" buttons via `scene.createButton` / `this.ui.createButton`
  // inside a gameplay system's onStart. Those buttons exist as 3D-space
  // labels/rects without the iframe-space HTML panel, so the ui_bridge
  // virtual cursor can't click them. The fix is to put all persistent UI
  // in an HTML panel under `project/ui/` and reference it via a `show_ui:`
  // action in the flow.
  //
  // Flag only when: the project HAS HTML UI panels (proving the author
  // knows the good path), AND a gameplay system calls createButton. That
  // narrows to "you had the tools and chose the bad tool," avoiding
  // false positives on headless test harnesses or in-editor debug buttons.
  if (Object.keys(p.runtime.files.uiHtmls ?? {}).length > 0) {
    const systemScripts = Object.entries(p.runtime.files.scripts ?? {})
      .filter(([k]) => k.startsWith('systems/'));
    const offenders: Array<{ file: string; line: number; snippet: string }> = [];
    const BTN_RE = /(scene|this\.scene|this\.ui|ui)\.createButton\s*\(/;
    for (const [file, src] of systemScripts) {
      const lines = src.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (BTN_RE.test(lines[i])) {
          offenders.push({ file, line: i + 1, snippet: lines[i].trim().slice(0, 80) });
          break;  // one hit per file is enough to flag it
        }
      }
    }
    if (offenders.length > 0) {
      results.push({
        name: 'no_scene_createbutton_in_gameplay_systems',
        failure: new PlaytestFailure('gameplay_ui_in_scene_layer',
          `${offenders.length} gameplay system${offenders.length > 1 ? 's' : ''} draw persistent buttons via \`scene.createButton\` / \`this.ui.createButton\` instead of declaring them in an HTML panel: ${offenders.slice(0, 3).map(o => `${o.file}:${o.line}`).join(', ')}. Scene-layer buttons render as unstyled rectangles and aren't reachable by the iframe-space virtual cursor — the user sees ugly placeholder buttons they can't click. Fix: move the buttons into \`project/ui/<panel>.html\`, trigger it with \`"show_ui:<panel>"\` in the relevant state's on_enter, and wire the button's click to emit a ui_event that a flow transition listens for. Keep scene.createButton ONLY for 3D-world callouts (waypoint markers, enemy health bars floating in space) — never for menu / HUD / restart-style UI.`,
          { offenders: offenders.slice(0, 10) }),
      });
    }
  }

  // ── 16b. Collider size must be consistent with the mesh scale ──
  //
  // The engine multiplies authored halfExtents by transform.scale at
  // collider-creation time. If an author types halfExtents as if they
  // were world-scale "what I want the collider to end up being" numbers,
  // the collider comes out transform.scale× bigger than the visible mesh.
  // Research run 835c86cd (FPS warehouse): wall_block had mesh.scale
  // [4,4,1] + collider halfExtents [2,2,0.5]. Effective collider was
  // 8×8×0.5 around a 4×4×1 visible mesh — invisible walls extending 2×
  // past the geometry the player can see.
  //
  // Detection: for entities with primitive-type meshes (cube/sphere/
  // capsule/plane/cylinder/cone), compare effective-collider-size to
  // effective-mesh-size. A ratio > 2× OR < 0.5× on any axis is suspect.
  // Custom GLB meshes skipped (we don't know their pre-scale bounds).
  {
    const PRIMITIVE_HALF: Record<string, { x: number; y: number; z: number }> = {
      cube: { x: 0.5, y: 0.5, z: 0.5 },
      box: { x: 0.5, y: 0.5, z: 0.5 },
      sphere: { x: 0.5, y: 0.5, z: 0.5 },
      capsule: { x: 0.5, y: 0.9, z: 0.5 },  // radius 0.5, height 1.8 → half 0.9 Y
      cylinder: { x: 0.5, y: 0.5, z: 0.5 },
      cone: { x: 0.5, y: 0.5, z: 0.5 },
      plane: { x: 0.5, y: 0.01, z: 0.5 },
    };
    const entDefs = p.runtime.files.entities?.definitions;
    if (entDefs && typeof entDefs === 'object') {
      const mismatches: Array<{ name: string; axis: string; ratio: number; meshHalf: number; colHalf: number }> = [];
      for (const [entName, rawDef] of Object.entries<any>(entDefs)) {
        const mt = (rawDef?.mesh?.type || '').toLowerCase();
        const prim = PRIMITIVE_HALF[mt];
        if (!prim) continue;  // custom / empty / unknown — skip
        const meshScale: any = rawDef?.mesh?.scale ?? [1, 1, 1];
        const msX = Array.isArray(meshScale) ? (meshScale[0] ?? 1) : (meshScale.x ?? 1);
        const msY = Array.isArray(meshScale) ? (meshScale[1] ?? 1) : (meshScale.y ?? 1);
        const msZ = Array.isArray(meshScale) ? (meshScale[2] ?? 1) : (meshScale.z ?? 1);
        const physCol: any = rawDef?.physics?.collider;
        if (!physCol || typeof physCol === 'string') continue;  // string shortcut OK
        const he = physCol.halfExtents;
        if (!he || !(Array.isArray(he) || typeof he === 'object')) continue;
        const cx = Array.isArray(he) ? (he[0] ?? 0.5) : (he.x ?? 0.5);
        const cy = Array.isArray(he) ? (he[1] ?? 0.5) : (he.y ?? 0.5);
        const cz = Array.isArray(he) ? (he[2] ?? 0.5) : (he.z ?? 0.5);
        // The engine multiplies BOTH authored halfExtents and the unit
        // primitive by transform.scale at runtime (physics_system.ts:376
        // `he.x * sx`). So engine-final-collider-half = cx * msX and
        // engine-final-mesh-half = prim.x * msX. Their ratio simplifies
        // to cx / prim.x — msX cancels. The previous formula left msX in
        // the denominator, which (a) flagged any wall with msX > 2 as a
        // false positive and (b) silently passed the very wall_block case
        // from 835c86cd (cx=2, prim=0.5, msX=4 → 1.0, "fine") that this
        // check was designed to catch.
        const rx = cx / prim.x;
        const ry = cy / prim.y;
        const rz = cz / prim.z;
        // Thin slabs (floor planes, decals, billboards) are fine to be
        // laterally oversized — a ground plane that collides past the
        // visible edge of the mesh doesn't cause invisible-wall complaints
        // because the plane is flat. Skip entities whose effective world
        // Y half-size is less than 0.5m.
        const effY = cy * Math.abs(msY);
        if (effY < 0.5) continue;
        // Flag only if AT LEAST TWO axes are simultaneously off by more
        // than 2× — a single-axis mismatch is usually a deliberate design
        // choice (thin wall with wider base, etc.); two axes off is the
        // "forgot scale multiplies" signature we saw in run 835c86cd
        // where wall_block had ratios [4, 4, 1]. Reported col/mesh values
        // are engine-final (post-scale) so the numbers in the failure
        // message match what the user sees in the editor.
        const badAxes: Array<{ axis: string; ratio: number; col: number; mesh: number }> = [];
        if (rx > 2 || rx < 0.5) badAxes.push({ axis: 'x', ratio: rx, col: cx * Math.abs(msX), mesh: prim.x * Math.abs(msX) });
        if (ry > 2 || ry < 0.5) badAxes.push({ axis: 'y', ratio: ry, col: cy * Math.abs(msY), mesh: prim.y * Math.abs(msY) });
        if (rz > 2 || rz < 0.5) badAxes.push({ axis: 'z', ratio: rz, col: cz * Math.abs(msZ), mesh: prim.z * Math.abs(msZ) });
        if (badAxes.length >= 2) {
          const worst = badAxes.reduce((a, b) => Math.abs(Math.log(a.ratio)) > Math.abs(Math.log(b.ratio)) ? a : b);
          mismatches.push({ name: entName, axis: worst.axis, ratio: worst.ratio, meshHalf: worst.mesh, colHalf: worst.col });
        }
      }
      if (mismatches.length > 0) {
        results.push({
          name: 'collider_matches_mesh_scale',
          failure: new PlaytestFailure('collider_size_mismatch',
            `${mismatches.length} entit${mismatches.length > 1 ? 'ies have' : 'y has'} colliders whose effective size disagrees with the scaled mesh by more than 2×: ${mismatches.slice(0, 5).map(m => `"${m.name}" (${m.axis}: collider half=${m.colHalf.toFixed(2)} vs scaled mesh half=${m.meshHalf.toFixed(2)}, ${m.ratio.toFixed(1)}×)`).join(', ')}. The engine multiplies collider halfExtents by transform.scale at runtime — if you authored halfExtents as world-space target sizes rather than pre-scale fractions, they'll be too big. Fix: for a primitive mesh at scale=[W,H,D], use halfExtents=[0.5,0.5,0.5] for cube (not [W/2, H/2, D/2]). The engine's scale multiply does the rest.`,
            { mismatches: mismatches.slice(0, 10) }),
        });
      }
    }
  }

  // ── 16c. Game-over state must hide the gameplay HUD ──
  //
  // Tic-tac-toe run 371845ed: game_over_win/lose/draw substates all had
  // both `show_ui:tictactoe_board` AND `show_ui:game_over` in on_enter.
  // Board stayed visible BEHIND the modal and the z-index fight made
  // the game_over screen partially obscured. Rule: a state that shows
  // a game_over / victory / defeat / results modal should HIDE the
  // gameplay HUD(s) in the same on_enter.
  //
  // Detection: for each state with name matching end-of-match patterns
  // AND on_enter containing a show_ui for a modal, if the on_enter also
  // contains a show_ui for a non-modal panel (suggesting the HUD is
  // being kept visible), flag.
  {
    const MODAL_RE = /^(game_over|victory|defeat|results|win|lose|draw|completed|finished|summary)/i;
    const GAMEOVER_STATE_RE = /game_over|victory|defeat|results|win|lose|draw|ended|completed/i;
    const states: any = p.runtime.files.flow?.states ?? {};
    const eachState = (name: string, def: any): Array<[string, any]> => {
      const out: Array<[string, any]> = [[name, def]];
      if (def?.substates) {
        for (const [sn, sd] of Object.entries<any>(def.substates)) out.push(...eachState(sn, sd));
      }
      return out;
    };
    const flat = Object.entries<any>(states).flatMap(([n, d]) => eachState(n, d));
    const offenders: Array<{ state: string; modal: string; hudPanel: string }> = [];
    for (const [stateName, stateDef] of flat) {
      if (!GAMEOVER_STATE_RE.test(stateName)) continue;
      const onEnter: string[] = Array.isArray(stateDef?.on_enter) ? stateDef.on_enter : [];
      const shows = onEnter
        .filter(op => typeof op === 'string' && op.startsWith('show_ui:'))
        .map(op => op.slice('show_ui:'.length));
      const modal = shows.find(s => MODAL_RE.test(s.split('/').pop() || s));
      if (!modal) continue;
      const nonModal = shows.find(s => !MODAL_RE.test(s.split('/').pop() || s));
      if (nonModal) {
        offenders.push({ state: stateName, modal, hudPanel: nonModal });
      }
    }
    if (offenders.length > 0) {
      results.push({
        name: 'game_over_hides_gameplay_hud',
        failure: new PlaytestFailure('hud_fights_modal',
          `${offenders.length} end-of-match state${offenders.length > 1 ? 's' : ''} show the game-over modal AND a gameplay HUD simultaneously: ${offenders.slice(0, 3).map(o => `state "${o.state}" shows both modal "${o.modal}" and HUD "${o.hudPanel}"`).join('; ')}. The HUD's z-index ends up higher than the modal in many layouts, partially or fully obscuring the end screen. Fix: in the end-state's on_enter, REPLACE \`show_ui:${offenders[0].hudPanel}\` with \`hide_ui:${offenders[0].hudPanel}\`; mirror with \`show_ui:${offenders[0].hudPanel}\` in on_exit so play-again returns the user to a full HUD.`,
          { offenders: offenders.slice(0, 5) }),
      });
    }
  }

  // ── 16d. Don't reimplement pinned library behaviors ──
  //
  // Run 13231daa (platformer) re-invented moving-platform motion inline
  // in systems/gameplay/platformer_level.ts — sin() + setPosition in
  // onUpdate. The pinned behaviors/ai/moving_platform.ts does exactly
  // this AND carries standing rigidbodies. Without the carry, players
  // slide off the platform every time it moves.
  //
  // Detection: script source grep for fingerprint patterns that match
  // a known pinned behavior AND the project doesn't reference the
  // pinned file. Two classes:
  //   (a) `Math.sin(... * some speed ...) * range` + `setPosition` in
  //       onUpdate → ad-hoc moving platform
  //   (b) `findEntitiesByTag("enemy")` + `setVelocity` for melee chase
  //       without the separation-vector pattern → crowd of enemies
  //       that'll pile up on the player's feet
  {
    const scripts = p.runtime.files.scripts ?? {};
    const scriptEntries = Object.entries<string>(scripts);
    const smells: Array<{ file: string; suggestedLibrary: string; why: string }> = [];

    // (a) moving-platform smell: oscillating setPosition without using
    //     the pinned behavior. Fingerprint: setPosition + Math.sin + tag
    //     or name mentioning "platform" / "mover".
    const hasMovingPlatformPinned =
      scriptEntries.some(([k]) => k.endsWith('/moving_platform.ts') && k.includes('ai/'));
    if (!hasMovingPlatformPinned) {
      for (const [file, src] of scriptEntries) {
        if (!/setPosition\s*\([^)]*Math\.sin/.test(src)) continue;
        if (!/platform|mover|oscillat|bob/i.test(src)) continue;
        smells.push({
          file,
          suggestedLibrary: 'behaviors/ai/moving_platform.ts',
          why: 'inline oscillating setPosition — the pinned moving_platform also carries standing rigidbodies, which hand-rolled versions forget',
        });
        break;  // one hit per game is enough
      }
    }

    // (b) chase-without-separation smell: finds enemies by tag, issues
    //     chase velocity, no separation vector summed from neighbors.
    const hasPinnedSeparation =
      scriptEntries.some(([k]) => k.endsWith('/enemy_chase_with_separation.ts'));
    // Tightened precondition (2026-04-26): the smell only makes sense if the
    // game actually HAS enemies. BAIT JUMPERS spent 5+ turns spinning on this
    // because the offending findEntitiesByTag("enemy") call was leftover
    // platformer-template residue — no enemy-shaped entity existed in
    // 02_entities.json. Skip the whole detector if no def's name or tag
    // substring-matches the enemy vocabulary; the residue ends up flagged
    // by other dead-code checks instead, with the right "delete" guidance.
    const ENEMY_NAME_RE = /(enemy|enemies|robot|zombie|ghost|goomba|skeleton|orc|minion|drone|npc|monster|mob|chaser|pursuer|hunter|hostile|cat|alien|slime|imp|wraith|goblin)/i;
    const entityDefs = p.runtime.files.entities?.definitions || {};
    const hasEnemyEntity = Object.entries<any>(entityDefs).some(([name, def]) => {
      if (ENEMY_NAME_RE.test(name)) return true;
      const tags: string[] = (def && def.tags) || [];
      return tags.some(t => typeof t === 'string' && ENEMY_NAME_RE.test(t));
    });
    if (!hasPinnedSeparation && hasEnemyEntity) {
      // Iteration 7 audit improvement: broaden the "separation already
      // implemented" detection to accept hand-rolled patterns. Authors who
      // wrote their own per-frame distance loop summing position deltas
      // shouldn't be told to scrap it — the pinned version is one valid
      // option, theirs is another.
      const SEPARATION_DETECTED_RE = [
        /for\s*\(\s*const\s+\w+\s+of\s+\w*[Ee]nem/,                            // for (const other of enemies)
        /for\s*\(\s*let\s+\w+\s*=\s*0\s*;\s*\w+\s*<\s*\w*[Ee]nem.*length/,      // for (let i = 0; i < enemies.length; ...)
        /Math\.sqrt.*position|position.*Math\.sqrt/,                           // distance math
        /\.distanceTo\s*\(/,                                                  // explicit distance call
        /normalize\s*\(\s*\)\s*\.\s*scale|sub\s*\([^)]+\)\s*\.\s*normalize/,    // direction calc
      ];
      // Require positive evidence of an enemy COLLECTION before flagging.
      // The whole reason this invariant exists is "multiple enemies pile
      // on the player" — if there's only ever one enemy, there's nothing
      // to separate from, and chase logic alone is not the smell. The
      // engine's only way to address a population is `findEntitiesByTag`,
      // so requiring a tag-query with an enemy-shaped tag literal is a
      // tight necessary-condition that sheds the false-positives we
      // were seeing on non-AI games (marble run flagged because it has
      // `findEntityByName("Player")` to grab the marble + a velocity-
      // reset call — both signals true, neither related to AI).
      // Tag literal must CONTAIN an enemy-shaped substring (so creative
      // names like "skeleton_warrior" or "wave_enemy_v2" still count).
      // Tight enough to skip generic tags like "pickup", "hazard",
      // "platform", "marble" — those don't substring-match any of these.
      const ENEMY_TAG_QUERY_RE =
        /findEntitiesByTag\(\s*["'][a-zA-Z0-9_]*?(enemy|enemies|robot|zombie|ghost|goomba|skeleton|orc|minion|drone|npc|monster|mob|chaser|pursuer|hunter|hostile)[a-zA-Z0-9_]*?["']\s*\)/i;
      for (const [file, src] of scriptEntries) {
        // Hard prerequisite: the file must address enemies as a population
        // (separation only makes sense between members of a population).
        if (!ENEMY_TAG_QUERY_RE.test(src)) continue;
        // Signal: calls setVelocity toward a player target inside a per-
        // frame update, no separation force loop.
        if (!/findEntityByName\(["']Player["']\)|findEntitiesByTag\(["']player["']\)/.test(src)) continue;
        if (!/setVelocity\s*\(/.test(src)) continue;
        // Negative (a): legacy "naive" check — looks for sep/repuls/personal
        // mentioned near a same-tag neighbor lookup.
        const hasSepLoop = /findEntitiesByTag\([^)]*\)[\s\S]{0,200}(sep|repuls|personal)/i.test(src);
        if (hasSepLoop) continue;
        // Negative (b): broadened detection — iterating neighbors with
        // distance math anywhere in the file is enough to assume the author
        // is doing their own separation. Avoids scolding people who
        // hand-rolled the math correctly.
        const hasSeparationLogic = SEPARATION_DETECTED_RE.some(re => re.test(src));
        if (hasSeparationLogic) continue;
        smells.push({
          file,
          suggestedLibrary: 'behaviors/ai/enemy_chase_with_separation.ts',
          why: 'enemy chase without personal-space separation — multiple enemies will pile on the player (towers of arms at eye height). The pinned version keeps them flanking instead.',
        });
        break;
      }
    }

    if (smells.length > 0) {
      results.push({
        name: 'avoid_reimplementing_pinned_behaviors',
        failure: new PlaytestFailure('reimplemented_pinned',
          `${smells.length} hand-rolled behavior${smells.length > 1 ? 's' : ''} look${smells.length > 1 ? '' : 's'} like ${smells.length > 1 ? '' : 'a '}pinned-library candidate${smells.length > 1 ? 's' : ''}: ${smells.map(s => `${s.file} → ${s.suggestedLibrary} (${s.why})`).join('; ')}. Three valid resolutions: (1) DELETE the offending code if it's residue from a copied template that doesn't apply to this game (e.g. enemy-chase code carried over from a platformer template but the new game has no enemies, or moving-platform code copied into a static-level game); (2) fetch the pinned implementation via \`bash library.sh show ${smells[0].suggestedLibrary}\`; (3) keep your hand-rolled implementation if it includes a per-frame distance loop summing position deltas (the broadened detector treats any neighbor iteration with distance math as "already separating") — applies to chase smells; for moving-platform smells the hand-rolled version is fine if you don't need riders carried.`,
          { smells }),
      });
    }
  }

  // ── 17. Orphan prefabs — declared but never placed or spawned ──
  // Run 502bd348: robot_enemy prefab was declared in 02_entities.json and
  // the warehouse_waves spawner system was registered in the FSM, but the
  // robots were never visible — likely a spawn-coords or spawner-timing
  // bug. An invariant that flags "declared but absent at runtime"
  // independently of how they're supposed to appear catches this class.
  //
  // A prefab is "reachable" if:
  //   (a) it's in 03_worlds placements[].ref, OR
  //   (b) some script source contains `scene.spawnEntity("<name>")` or
  //       `scene.hasPrefab("<name>")` or `createEntity("<name>")`
  //
  // We ignore prefabs whose names look like pure building-blocks (ground,
  // camera, boundary) — they're meant to be placed directly; we care about
  // gameplay-signalling ones (enemy/boss/pickup/coin/wave/robot/...) that
  // are declared for a reason.
  const defs = p.runtime.files.entities?.definitions;
  if (defs && typeof defs === 'object') {
    const GAMEPLAY_NAME_RE = /(enemy|boss|minion|robot|zombie|goomba|orc|goblin|skeleton|slime|drone|ufo|coin|pickup|collectable|collectible|gem|powerup|crystal|star|orb|rune|cookie|wave|hazard|projectile|bullet|missile|bomb|rocket)/i;
    // Iteration 7 audit improvement: skip projectile/bullet/missile-shaped
    // prefabs entirely — they spawn in response to player ACTION (firing a
    // weapon), not on idle ticks. The orphan check would false-positive on
    // them every time because the playtest doesn't pull the trigger.
    const PROJECTILE_SUFFIX_RE = /_(bullet|projectile|missile|rocket|arrow|shot|laser|beam)$/i;
    const placements = (p.runtime.files.worlds?.worlds ?? []).flatMap((w: any) => (w.placements ?? []));
    const placed = new Set<string>(placements.map((pl: any) => pl.ref).filter(Boolean));
    const allScripts = Object.values(p.runtime.files.scripts ?? {}).join('\n');
    // Iteration 7 audit improvement: scrape template-literal spawn calls so
    // a `spawnEntity(\`enemy_${pattern}\`)` site marks every prefab whose
    // name shares the literal head ("enemy_") as potentially spawned. Without
    // this, dynamically-named projectile/enemy variants false-flag as orphans.
    const TEMPLATE_SPAWN_RE = /spawnEntity\s*\(\s*`([^`]*)`/g;
    const templateHeads: string[] = [];
    let tm: RegExpExecArray | null;
    while ((tm = TEMPLATE_SPAWN_RE.exec(allScripts)) !== null) {
      // Take the literal text up to the first `${` or end-of-template; that's
      // the prefix every concrete name will share.
      const literal = tm[1];
      const head = literal.split('${')[0];
      if (head) templateHeads.push(head);
    }
    const orphans: string[] = [];
    for (const name of Object.keys(defs)) {
      if (placed.has(name)) continue;
      if (!GAMEPLAY_NAME_RE.test(name)) continue;  // only flag gameplay-named ones
      if (PROJECTILE_SUFFIX_RE.test(name)) continue;  // skip player-action-spawned things
      // Look for spawnEntity("name") / hasPrefab("name") / createEntity("name") in any script source.
      const q1 = `spawnEntity("${name}")`;
      const q2 = `spawnEntity('${name}')`;
      const q3 = `hasPrefab("${name}")`;
      const q4 = `createEntity("${name}")`;
      // Template-literal head match: if any spawnEntity(`<head>${…}`) site's
      // literal head is a prefix of this prefab's name, treat as potentially
      // spawned and exercise the live runtime check below.
      const templateMatches = templateHeads.length > 0 && templateHeads.some(h => h.length > 0 && name.startsWith(h));
      if (allScripts.includes(q1) || allScripts.includes(q2) || allScripts.includes(q3) || allScripts.includes(q4) || templateMatches) {
        // It's spawned dynamically — check if any instances appear at runtime.
        // Tick briefly to let spawners run, then scan.
        const snap = p.snapshot();
        let found = false;
        try {
          p.activateAllBehaviors();
          p.tickSeconds(3);
          const scene: any = p.runtime.scene;
          if (scene) {
            for (const e of scene.entities.values()) {
              if (e.name === name || e.name.startsWith(name + '_') || (e as any).definitionName === name) {
                found = true; break;
              }
            }
          }
        } catch {}
        p.restore(snap);
        if (!found) orphans.push(name);
      } else {
        orphans.push(name);
      }
    }
    if (orphans.length > 0) {
      results.push({
        name: 'declared_prefabs_reachable',
        failure: new PlaytestFailure('orphan_prefab',
          `${orphans.length} gameplay-named prefab${orphans.length > 1 ? 's are' : ' is'} declared in 02_entities.json but never placed in 03_worlds.json and never materialize at runtime via spawnEntity: ${orphans.slice(0, 5).map(n => `"${n}"`).join(', ')}${orphans.length > 5 ? ` (+${orphans.length - 5} more)` : ''}. Three valid resolutions: (1) DELETE the prefab definitions from 02_entities.json if they're residue from a copied template that doesn't apply to this game (e.g. enemy_slime/skeleton/dragon left over from tower_siege but the new game uses different enemy names — just remove the unused defs); (2) add placements for them in 03_worlds.json; (3) write a spawner system that calls \`scene.spawnEntity("${orphans[0]}")\` from active_systems during the gameplay state. If a spawner system exists but they're still absent after 3s of ticks, check the spawner's active_behaviors/active_systems gating and its spawn coordinates — the robots in run 502bd348 had a spawner registered but spawned outside the visible play area.`,
          { orphans, total: orphans.length }),
      });
    }
  }

  // ── 18. Behaviors listening for events nothing emits ──
  //
  // `scene.events.game.on("<name>", ...)` will happily register a
  // listener for a name that nothing emits — the listener just never
  // fires, and type checkers can't see it. The classic trap is pasting
  // a behavior from a racing template (which emits `race_start` from
  // its flow) into a non-racing game whose flow emits `restart_game`
  // instead. Driving run eb39528d had exactly this: car_control.ts
  // listened for `race_start`, but the flow's play_again transition
  // emitted `restart_game`. Car never reset position on replay.
  //
  // Static check: build the universe of emitted game events from
  //   (a) flow `emit:game.<name>` strings (on_enter/on_update/on_exit/
  //       actions of every transition, including substates)
  //   (b) `events.game.emit("<name>", ...)` in any project script
  //   (c) `_emitBus("game", "<name>", ...)` (fsm_driver's helper)
  //   (d) engine-side emits the runtime performs from non-script code
  //       (sceneReloading — add to the whitelist below if more get added)
  // Then scan each non-transport behavior/system script for
  //   `events.game.on("<name>", ...)` and flag any whose name isn't
  //   in the universe.
  //
  // Universal — every genre benefits. Transport scripts (ui_bridge,
  // mp_bridge, fsm_driver, event_definitions) are excluded because
  // they legitimately listen for engine-level events that may not
  // appear in script sources.
  {
    const scripts = p.runtime.projectScripts ?? {};
    const flow = p.runtime.files.flow;

    // Emit universe — events the game can actually produce.
    const emittedEvents = new Set<string>([
      // Engine-side emits (from frontend/runtime + shared/scripting).
      'sceneReloading',
    ]);

    // (a) Flow strings: "emit:game.<name>". Walk every state/substate,
    // check on_enter / on_update / on_exit arrays AND every transition's
    // `actions` array.
    const FLOW_EMIT_RE = /^emit:game\.(.+)$/;
    const walkFlowEmits = (states: any): void => {
      for (const def of Object.values<any>(states ?? {})) {
        if (!def || typeof def !== 'object') continue;
        for (const arrKey of ['on_enter', 'on_update', 'on_exit']) {
          const arr = def[arrKey];
          if (!Array.isArray(arr)) continue;
          for (const op of arr) {
            if (typeof op !== 'string') continue;
            const m = op.match(FLOW_EMIT_RE);
            if (m) emittedEvents.add(m[1]);
          }
        }
        const transitions = def.transitions;
        if (Array.isArray(transitions)) {
          for (const t of transitions) {
            const acts = t?.actions;
            if (!Array.isArray(acts)) continue;
            for (const op of acts) {
              if (typeof op !== 'string') continue;
              const m = op.match(FLOW_EMIT_RE);
              if (m) emittedEvents.add(m[1]);
            }
          }
        }
        if (def.substates) walkFlowEmits(def.substates);
      }
    };
    walkFlowEmits(flow?.states);

    // (b) + (c) Script emits on the `game` bus. Two syntaxes in the
    // wild: `events.game.emit("<name>", ...)` and fsm_driver's
    // `_emitBus("game", "<name>", ...)` helper. Also the alias-then-emit
    // pattern (e.g. `var gbus = events.game; gbus.emit("...", ...)`)
    // which mp_bridge uses for perf — the invariant treats any
    // `<word>.emit("string", ...)` as an emit if the same script also
    // sets up the alias from events.game.
    const SCRIPT_EMIT_RE_1 = /events\.game\.emit\s*\(\s*["']([^"']+)["']/g;
    const SCRIPT_EMIT_RE_2 = /_emitBus\s*\(\s*["']game["']\s*,\s*["']([^"']+)["']/g;
    const SCRIPT_EMIT_RE_3 = /\b\w+\.emit\s*\(\s*["']([^"']+)["']/g;
    const ALIAS_RE = /\b(?:var|let|const)\s+\w+\s*=\s*[^;=]*events\.game\b/;
    for (const src of Object.values(scripts)) {
      let m: RegExpExecArray | null;
      SCRIPT_EMIT_RE_1.lastIndex = 0;
      while ((m = SCRIPT_EMIT_RE_1.exec(src)) !== null) emittedEvents.add(m[1]);
      SCRIPT_EMIT_RE_2.lastIndex = 0;
      while ((m = SCRIPT_EMIT_RE_2.exec(src)) !== null) emittedEvents.add(m[1]);
      // Only collect aliased emits when the source declares an alias of
      // events.game — otherwise `someUnrelated.emit("x")` would falsely
      // satisfy a listener for "x".
      if (ALIAS_RE.test(src)) {
        SCRIPT_EMIT_RE_3.lastIndex = 0;
        while ((m = SCRIPT_EMIT_RE_3.exec(src)) !== null) emittedEvents.add(m[1]);
      }
    }

    // Listeners — scan non-transport scripts for `events.game.on(...)`.
    // Same assembler-flattened path shape as the advertised_keys
    // invariant uses (`scripts/ui_ui_bridge.ts`, not `systems/ui/ui_bridge.ts`).
    const TRANSPORT_RE = /(^|[\/_])(ui_bridge|mp_bridge|fsm_driver|_entity_label|event_definitions|_event_validator)(_[^/]*)?\.ts$/;
    const LISTEN_RE = /events\.game\.on\s*\(\s*["']([^"']+)["']/g;
    // Multiplayer transport events are dispatched by mp_bridge with a
    // dynamic suffix (`gbus.emit("net_" + event, ...)`) so the literal
    // name never appears in source. Any `net_<name>` and `mp_<name>`
    // listener is assumed live as long as the project includes mp_bridge.
    const TRANSPORT_EVENT_RE = /^(net_|mp_)/;
    const hasMpBridge = Object.keys(scripts).some(p => /mp_bridge/.test(p));
    const deadListeners: Array<{ name: string; script: string }> = [];
    const seen = new Set<string>();
    for (const [scriptPath, src] of Object.entries(scripts)) {
      if (TRANSPORT_RE.test(scriptPath)) continue;
      LISTEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LISTEN_RE.exec(src)) !== null) {
        const evtName = m[1];
        if (emittedEvents.has(evtName)) continue;
        if (hasMpBridge && TRANSPORT_EVENT_RE.test(evtName)) continue;
        const key = `${scriptPath}::${evtName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        deadListeners.push({ name: evtName, script: scriptPath });
      }
    }

    if (deadListeners.length > 0) {
      const first = deadListeners.slice(0, 5).map(d => `"${d.name}" in ${d.script}`).join(', ');
      const more = deadListeners.length > 5 ? ` (+${deadListeners.length - 5} more)` : '';
      results.push({
        name: 'behavior_listens_for_unemitted_event',
        failure: new PlaytestFailure('dead_listener',
          `${deadListeners.length} script listener${deadListeners.length > 1 ? 's' : ''} registered for game events nothing emits: ${first}${more}. Three valid resolutions: (1) DELETE the listener if it's residue from a copied template/library that this game doesn't need; (2) rename the listener to match an event that IS emitted (grep "emit:game." in 01_flow.json and "events.game.emit" in other scripts for the canonical name — most commonly "restart_game" for play-again resets); (3) add the emit from a flow transition or system where the event should originate. Silent no-op listeners are the #1 cause of "works first time but not after replay" bugs.`,
          { deadListeners }),
      });
    } else {
      results.push({ name: 'behavior_listens_for_unemitted_event', failure: null });
    }
  }

  // ── 17. HUD HTML reads keys that no script ever provides ──────────────
  // Iteration 6's bullet_hell run shipped with `s.health` / `s.maxHealth`
  // bound to a HUD bar that never updated — backend tracked damage but
  // no script ever called `events.ui.emit("hud_update", { health, maxHealth })`.
  // The same class hit JRPG (caught by an authored test, not an invariant)
  // with `bossMaxHP`. The class is generic across every genre with a HUD:
  // a binding mismatch between the HTML's read and the script's writes.
  //
  // Static analysis: scan ui/hud/*.html for `s.<key>` / `state.<key>` reads
  // in the message handler, then scan all scripts + flow.json for any
  // place that emits a `hud_update` / `state_changed` payload mentioning
  // that key, OR sets it on `_state[key] = …` (the ui_bridge merge path).
  // Implicit FSM-driver-published keys (`phase`, flow `vars`, `<panel>Visible`
  // from show_ui actions, `_notification` from show_notification) are
  // treated as provided. Any HUD-read key not in the union fires.
  {
    const uiHtmls = p.runtime.files.uiHtmls ?? {};
    const hudHtmls = Object.entries<string>(uiHtmls).filter(([k]) => /\/hud\//.test(k) || /hud[^/]*\.html$/i.test(k));
    if (hudHtmls.length > 0) {
      // Common JS string/array methods + global properties to filter
      // from `s.<x>` / `state.<x>` matches. Conservative — only filter
      // names that are clearly never user state keys.
      const METHOD_NOISE = new Set([
        'trim', 'slice', 'split', 'replace', 'concat', 'indexOf', 'includes', 'toLowerCase',
        'toUpperCase', 'toString', 'length', 'charAt', 'charCodeAt', 'startsWith', 'endsWith',
        'padStart', 'padEnd', 'repeat', 'match', 'matchAll', 'search', 'substring',
        'substr', 'valueOf', 'forEach', 'map', 'filter', 'reduce', 'find', 'findIndex',
        'push', 'pop', 'shift', 'unshift', 'sort', 'reverse', 'join', 'flat', 'flatMap',
        'every', 'some', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable',
        'constructor', 'prototype', '__proto__',
      ]);

      // Discover provider keys from scripts + flow.json.
      const provided = new Set<string>();
      // Always-published keys: ui_bridge merges show_ui/hide_ui into <panel>Visible
      // and show_notification into _notification; FSM driver merges `phase`.
      provided.add('phase');
      provided.add('_notification');

      const scripts = p.runtime.projectScripts ?? p.runtime.files.scripts ?? {};
      // Keys mentioned in any object literal payload of hud_update / state_changed.
      // Object-literal range matching is greedy across newlines — we accept any
      // `<word>:` inside the matched `{ ... }` block as a provided key.
      const PAYLOAD_RE = /events\.(?:ui|game)\.emit\s*\(\s*['"](?:hud_update|state_changed)['"]\s*,\s*\{([\s\S]{0,1500}?)\}\s*\)/g;
      const KEY_IN_PAYLOAD = /(\w+)\s*:/g;
      // Direct merges into the bridge state: `self._state.foo = …`,
      // `this._state["foo"] = …`, `state.foo = …`, etc. Catches scripts
      // that mutate the bridge directly without going through emit.
      const STATE_SET_RE = /(?:_state|self\._state|this\._state|state)\s*(?:\.(\w+)|\[\s*['"](\w+)['"]\s*\])\s*=/g;
      // Var-payload fallback: `var payload = { foo: …, bar: … }` — if the
      // very next call is `emit("hud_update", payload)`, the keys count.
      // Conservative: just accept any object-literal key that appears in
      // the same script as an emit("hud_update", <ident>) call.
      for (const [scriptPath, src] of Object.entries(scripts) as Array<[string, string]>) {
        for (const m of src.matchAll(PAYLOAD_RE)) {
          const inner = m[1];
          for (const km of inner.matchAll(KEY_IN_PAYLOAD)) provided.add(km[1]);
        }
        for (const m of src.matchAll(STATE_SET_RE)) {
          const k = m[1] || m[2];
          if (k) provided.add(k);
        }
        // Var-payload heuristic: scripts that build a payload as a local
        // variable then pass it to hud_update / state_changed. Two
        // construction patterns are common:
        //   1. Initial-literal:  `var d = { score: ..., lives: ... };`
        //   2. Post-mutation:    `var d = {}; d.score = …; d.p1Health = …;`
        //                        `var d = { score: 0 }; d.combo = 3;`
        // The fighter game (run d8f32a95) builds via (2) and would
        // generate false positives without this extension.
        const varEmit = /events\.(?:ui|game)\.emit\s*\(\s*['"](?:hud_update|state_changed)['"]\s*,\s*(\w+)\s*\)/g;
        const varNames = new Set<string>();
        for (const vm of src.matchAll(varEmit)) varNames.add(vm[1]);
        if (varNames.size > 0) {
          const varDeclRe = /(?:var|let|const)\s+(\w+)\s*=\s*\{([\s\S]{0,1500}?)\}\s*;/g;
          for (const vd of src.matchAll(varDeclRe)) {
            if (varNames.has(vd[1])) {
              for (const km of vd[2].matchAll(KEY_IN_PAYLOAD)) provided.add(km[1]);
            }
          }
          // Post-mutation: any `<varname>.<key> = …` or
          // `<varname>['<key>'] = …` where varname is in our emit set.
          // Also catches `<varname>.<key>++` etc. — anything that
          // mutates a property of a payload variable counts as a
          // provided key. We accept either ident-keyed or string-keyed.
          for (const vname of varNames) {
            const dotRe = new RegExp(`\\b${vname}\\s*\\.(\\w+)`, 'g');
            for (const m of src.matchAll(dotRe)) provided.add(m[1]);
            const idxRe = new RegExp(`\\b${vname}\\s*\\[\\s*['"](\\w+)['"]\\s*\\]`, 'g');
            for (const m of src.matchAll(idxRe)) provided.add(m[1]);
          }
        }
        void scriptPath;
      }

      // Flow.json: `vars` per state are merged into `state_changed` by the
      // FSM driver; `show_ui` actions create `<panel>Visible` flags.
      const flow: any = p.runtime.files.flow;
      const walkFlow = (states: Record<string, any> | undefined): void => {
        if (!states) return;
        for (const def of Object.values<any>(states)) {
          for (const k of Object.keys(def?.vars ?? {})) provided.add(k);
          for (const hook of ['on_enter', 'on_exit', 'on_update', 'on_timeout'] as const) {
            const list = def?.[hook];
            if (!Array.isArray(list)) continue;
            for (const a of list) {
              if (typeof a !== 'string') continue;
              // Match the FULL panel path after `show_ui:` — panel names can
              // include slashes (`show_ui:hud/clicker`) and dots; the
              // ui_bridge strips non-alphanumerics before appending
              // "Visible", so we mirror that here.
              const showM = a.match(/^show_ui:(.+)$/);
              if (showM) {
                const rawPanel = showM[1].trim();
                // Drop trailing `.html` if present — pinned ui_bridge tolerates both.
                const noExt = rawPanel.replace(/\.html$/i, '');
                const panel = noExt.replace(/[^a-zA-Z0-9_]/g, '');
                if (panel) provided.add(panel + 'Visible');
              }
            }
          }
          if (def?.substates) walkFlow(def.substates);
        }
      };
      walkFlow(flow?.states);

      // For each HUD HTML, extract `s.<key>` / `state.<key>` reads from
      // `<script>...</script>` blocks. We only look inside the message
      // listener handler — a permissive but cheap approach: scan the
      // whole script tag, but only count names whose alias was assigned
      // from `e.data.state` (the canonical pattern) OR `e.data` directly.
      const dead: Array<{ html: string; key: string }> = [];
      for (const [htmlPath, html] of hudHtmls) {
        // Pull script-tag contents only — HTML attributes shouldn't drive this.
        const scriptBlocks: string[] = [];
        const blockRe = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
        let bm: RegExpExecArray | null;
        while ((bm = blockRe.exec(html)) !== null) scriptBlocks.push(bm[1]);
        if (scriptBlocks.length === 0) continue;
        const js = scriptBlocks.join('\n');

        // Identify aliases assigned from `e.data.state || …` or `e.data`.
        // The pinned pattern is: `var s = e.data.state || {};` — alias `s`.
        // Some HUDs use `state` directly. Accept both.
        const aliasNames = new Set<string>();
        const aliasRe = /(?:var|let|const)\s+(\w+)\s*=\s*e\.data(?:\.state)?\b/g;
        let am: RegExpExecArray | null;
        while ((am = aliasRe.exec(js)) !== null) aliasNames.add(am[1]);
        // Always treat `state` as an alias if the script reads `state.<key>`
        // — covers handlers that destructure or pre-bind.
        aliasNames.add('state');

        const candidates = new Set<string>();
        for (const alias of aliasNames) {
          const re = new RegExp(`\\b${alias}\\.(\\w+)`, 'g');
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(js)) !== null) candidates.add(mm[1]);
        }

        for (const k of candidates) {
          if (METHOD_NOISE.has(k)) continue;
          if (k.startsWith('_')) continue; // private/internal
          if (provided.has(k)) continue;
          dead.push({ html: htmlPath, key: k });
        }
      }

      if (dead.length > 0) {
        const sample = dead.slice(0, 5).map(d => `"s.${d.key}" in ${d.html}`).join(', ');
        const more = dead.length > 5 ? ` (+${dead.length - 5} more)` : '';
        results.push({
          name: 'hud_html_field_resolves',
          failure: new PlaytestFailure('hud_field_unresolved',
            `${dead.length} HUD field${dead.length > 1 ? 's' : ''} read from gameState but never emitted by any script: ${sample}${more}. The HUD will display its initial-static value forever. Either (a) emit \`events.ui.emit("hud_update", { ${dead[0].key}: <value> })\` from the behavior/system that owns this state, or (b) remove the unused read from the HUD HTML. Iteration 6's bullet_hell run shipped this exact class for s.health/s.maxHealth — backend tracked damage but the bar stayed full because no \`hud_update\` payload mentioned the key.`,
            { dead: dead.slice(0, 20), totalDead: dead.length }),
        });
      } else if (hudHtmls.length > 0) {
        results.push({ name: 'hud_html_field_resolves', failure: null });
      }
    }
  }

  // ── 17b. HUD panels visible together must not visually overlap ────────
  // Two HUD HTMLs that pin to the same screen corner with intersecting
  // bounding boxes will draw on top of each other once the player enters
  // a state that show_ui's both. Strict mode: only fires when geometry
  // clearly intersects — top/bottom-center pairs check y-overlap only
  // since x is viewport-relative. The 4x_strategy fix (2026-04-25)
  // motivated this — generic scoreboard panels stacked on top of
  // template-specific HUDs in 6+ shipped templates.
  {
    const flow: any = p.runtime.files.flow;
    const uiHtmls = p.runtime.files.uiHtmls ?? {};
    if (flow?.states && Object.keys(uiHtmls).length > 0) {
      const overlaps = analyzeHudOverlaps(flow, uiHtmls);
      if (overlaps.length > 0) {
        const first = overlaps.slice(0, 4).map(o =>
          `[${o.state}] ${o.a.ref} (${o.a.anchor}) overlaps ${o.b.ref}`,
        ).join('; ');
        const more = overlaps.length > 4 ? ` (+${overlaps.length - 4} more)` : '';
        results.push({
          name: 'hud_panels_no_overlap',
          failure: new PlaytestFailure('hud_overlap',
            `${overlaps.length} HUD panel pair${overlaps.length > 1 ? 's' : ''} visually overlap during gameplay: ${first}${more}. Two panels pinned to the same screen corner with intersecting CSS positions will draw on top of each other. Either (a) reposition one panel to a different corner / different offset, or (b) drop one of the redundant panels from the gameplay state's show_ui list (often a generic hud/* is duplicated by a game-specific HUD).`,
            { overlaps: overlaps.slice(0, 20), total: overlaps.length }),
        });
      } else {
        results.push({ name: 'hud_panels_no_overlap', failure: null });
      }
    }
  }

  // ── 18. Action methods must produce visible feedback ──────────────────
  // Iteration 6's fighting game (d8f32a95) shipped without any attack
  // animation — the user pressed F/G/H, damage applied, but the
  // character mesh never moved or played a clip. Same class affects
  // beat-em-up `_doPunch`, FPS `_doShoot`, RTS `_doAttack`, etc.
  //
  // Static analysis: find every behavior method whose name matches an
  // action verb (attack/punch/kick/shoot/fire/swing/slash/stab/cast/
  // dash/special). Inside its body require ONE of:
  //   - `playAnimation(...)` call
  //   - emit of an event whose name contains a feedback verb
  //     (swing/anim/fire/shoot/hit/attack — downstream animation-system
  //     trigger)
  //   - mesh-transform mutation (transform.scale, transform.rotation)
  //   - audio.playSound(...) (audible feedback is acceptable when
  //     visual is genuinely impractical, e.g. invisible projectile)
  //
  // Method body extracted by brace-depth counting from the method
  // header. Conservative naming match avoids false positives on
  // gameplay-system helpers like `_spawnEnemy`.
  {
    // Negative lookbehind for `.` excludes method-call sites
    // (`this._fire()`) — we want only method declarations.
    const ACTION_METHOD_RE = /(?<![.\w])(?:_?do[A-Z]\w*|_?on[A-Z]\w*|_?perform[A-Z]\w*|_(?:attack|punch|kick|shoot|fire|swing|slash|stab|cast|dash|special))\s*\(/g;
    const ACTION_VERB_RE = /^_?(?:do|on|perform)?(?:Attack|Punch|Kick|Shoot|Fire|Swing|Slash|Stab|Cast|Dash|Special|Strike|Smash|Hit|Throw|Bash|Whip)/i;
    const FEEDBACK_VERB_RE = /(?:swing|anim|fire|shoot|hit|attack|punch|kick|swing|slash|cast|dash|special)/i;
    const scripts2 = p.runtime.projectScripts ?? p.runtime.files.scripts ?? {};
    const missing: Array<{ script: string; method: string }> = [];

    const extractMethodBody = (src: string, headerStart: number): string | null => {
      // Find the opening brace that starts the method body.
      const open = src.indexOf('{', headerStart);
      if (open < 0) return null;
      let depth = 1;
      let i = open + 1;
      while (i < src.length && depth > 0) {
        const ch = src[i];
        if (ch === '"' || ch === "'" || ch === '`') {
          // Skip string literal
          const quote = ch;
          i++;
          while (i < src.length && src[i] !== quote) {
            if (src[i] === '\\') i++;
            i++;
          }
          i++;
          continue;
        }
        if (ch === '/' && src[i + 1] === '/') {
          // Line comment
          while (i < src.length && src[i] !== '\n') i++;
          continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
          // Block comment
          i += 2;
          while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++;
          i += 2;
          continue;
        }
        if (ch === '{') depth++;
        else if (ch === '}') depth--;
        i++;
      }
      if (depth !== 0) return null;
      return src.slice(open + 1, i - 1);
    };

    // Pre-scan: for each script, for each event name listened-for, build a
    // map name → set of listener bodies. Used so that if an action method
    // emits `<verb>_swing`, we can verify that some listener for that
    // event actually calls playAnimation. A symbolic emit into a void
    // doesn't count — that's iteration 6's fighter (`melee_swing` is
    // emitted but has zero listeners and zero playAnimation calls
    // anywhere in the artifact).
    const listenersAnimating = new Set<string>();
    for (const [scriptPath, src] of Object.entries(scripts2) as Array<[string, string]>) {
      const onRe = /events\.(?:game|ui)\.on\s*\(\s*['"]([^'"]+)['"]\s*,/g;
      let om: RegExpExecArray | null;
      while ((om = onRe.exec(src)) !== null) {
        const evtName = om[1];
        // Find body of the listener — open brace after `function() {`
        // or arrow `=> {`.
        const after = src.slice(om.index + om[0].length, om.index + om[0].length + 600);
        if (/playAnimation\s*\(/.test(after) || /transform\.(?:scale|rotation|setRotation|setScale)/.test(after) || /setRotationEuler\b/.test(after)) {
          listenersAnimating.add(evtName);
        }
      }
      void scriptPath;
    }

    for (const [scriptPath, src] of Object.entries(scripts2) as Array<[string, string]>) {
      // Skip pinned-library / transport / engine machinery.
      if (/_event_validator|event_definitions|fsm_driver|ui_bridge|mp_bridge|_entity_label/.test(scriptPath)) continue;
      let m: RegExpExecArray | null;
      while ((m = ACTION_METHOD_RE.exec(src)) !== null) {
        // Reset header to start of token, drop the trailing `(`.
        const fullName = m[0].replace(/\s*\($/, '');
        if (!ACTION_VERB_RE.test(fullName)) continue;
        const body = extractMethodBody(src, m.index);
        if (body == null || body.length < 5) continue;
        const hasAnim = /\bplayAnimation\s*\(/.test(body);
        const hasMeshMutate = /\btransform\.(?:scale|rotation|setRotation|setScale)/.test(body)
          || /\bsetRotationEuler\b/.test(body)
          || /\bplayParticle\b|\bemitParticles\b/.test(body);
        // Spawning a visible entity (bullet, projectile, hit-spark prefab,
        // VFX prefab) counts as visible feedback — the bullet appears
        // mid-air, the user sees the action's effect. bullethell `_fire()`
        // works this way.
        const hasSpawn = /\bspawnEntity\s*\(/.test(body) || /\binstantiatePrefab\s*\(/.test(body);
        // Feedback-via-event-bus only counts if SOMETHING listens for
        // that event AND that listener actually animates. A bare emit
        // is symbolic — no visual effect for the user. Iteration 6's
        // fighter emitted `melee_swing` into a void.
        const hasValidFeedbackEmit = (() => {
          const emitRe = /events\.(?:game|ui)\.emit\s*\(\s*['"]([^'"]+)['"]/g;
          let em: RegExpExecArray | null;
          while ((em = emitRe.exec(body)) !== null) {
            const evtName = em[1];
            if (FEEDBACK_VERB_RE.test(evtName) && listenersAnimating.has(evtName)) return true;
          }
          return false;
        })();
        if (!hasAnim && !hasMeshMutate && !hasSpawn && !hasValidFeedbackEmit) {
          // Final fallback: if body is very small (< 4 statements) and
          // delegates to another method (`this._<verb>(…)`), assume the
          // delegate provides feedback. Conservative — avoids false
          // positives on dispatcher methods.
          if (/this\._\w+\s*\(/.test(body) && body.split(';').length <= 6) continue;
          missing.push({ script: scriptPath, method: fullName });
        }
      }
      ACTION_METHOD_RE.lastIndex = 0;
    }

    if (missing.length > 0) {
      const sample = missing.slice(0, 5).map(m => `${m.method}() in ${m.script}`).join(', ');
      const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
      results.push({
        name: 'action_has_visible_feedback',
        failure: new PlaytestFailure('action_no_feedback',
          `${missing.length} action method${missing.length > 1 ? 's' : ''} run damage/effects but produce zero visible/audible feedback for the player: ${sample}${more}. The user presses the key, the action fires (cooldown, damage, hit detection all run), but nothing visibly changes. Add ONE of: \`this.entity.playAnimation("Punch", { loop: false })\`, an event emit like \`events.game.emit("attack_swing", { … })\` for an animation system to react, a brief mesh tweak (transform.scale pulse), or \`this.audio.playSound(…)\`. Iteration 6's fighting game (d8f32a95) shipped this exact class for _doAttack/_doPunch/_doKick/_doSpecial — damage worked but the user said "no animation when im doing an attack."`,
          { missing: missing.slice(0, 20), totalMissing: missing.length }),
      });
    } else {
      results.push({ name: 'action_has_visible_feedback', failure: null });
    }
  }

  // ── 19. playAnimation calls reference clips that exist on the GLB ──
  // Iteration 6's fighter shipped without animation feedback partly
  // because we couldn't tell from the source whether the chosen clip
  // names ("Punch", "Spellcast_Long") existed on the bound GLB. The
  // engine's playAnimation wraps a try/catch around the clip lookup,
  // so missing clips fail silently — the user sees "no animation"
  // with no error in the console.
  //
  // Static analysis: build a map (entityName → meshAsset) from
  // 02_entities.json. For each behaviour script attached to an entity,
  // parse `entity.playAnimation("X", …)` calls. Look up the entity's
  // GLB clips in `data/glb_clip_manifest.json` (pre-baked at build
  // time). Validate "X" against the clip list using the same
  // case-insensitive substring match the engine does
  // (animator_component.resolveClipName). Fire on unresolved.
  //
  // Skip entirely when the manifest is missing (treat as advisory in
  // dev environments without the manifest pre-built).
  {
    const clipManifest = loadGlbClipManifest();
    const defs: any = p.runtime.files.entities?.definitions;
    const scripts: Record<string, string> = p.runtime.projectScripts ?? p.runtime.files.scripts ?? {};
    if (clipManifest && defs && Object.keys(scripts).length > 0) {
      // Map flattened script path → behaviour list of (entityName, meshAsset).
      // The level-assembler flattens `behaviors/movement/foo.ts` into
      // `scripts/movement_foo.ts` (and per-entity copies with a name
      // suffix when params are injected). We match by the leaf-folder
      // and filename convention the assembler uses.
      const behaviourBindings: Map<string, Array<{ entityName: string; meshAsset: string; clips: string[] }>> = new Map();
      for (const [entityName, def] of Object.entries<any>(defs)) {
        const meshAsset: string | undefined = def?.mesh?.asset;
        if (!meshAsset) continue;
        const manifestEntry = clipManifest[meshAsset];
        if (!manifestEntry) continue;  // unknown asset (custom upload?) — skip
        for (const b of (def.behaviors ?? []) as any[]) {
          const scriptRef: string | undefined = b?.script;
          if (!scriptRef) continue;
          // The assembler flattens path slashes to underscores and prefixes `scripts/`.
          // Plus a per-entity copy when params are injected — matching the
          // bare flattened key catches the canonical script copy at minimum.
          const flat = 'scripts/' + scriptRef.replace(/\//g, '_');
          const list = behaviourBindings.get(flat) ?? [];
          list.push({ entityName, meshAsset, clips: manifestEntry.clips });
          behaviourBindings.set(flat, list);
        }
      }
      const PLAY_ANIM_RE = /\bentity\.playAnimation\s*\(\s*['"]([^'"]+)['"]/g;
      const unresolved: Array<{ script: string; entity: string; clip: string; available: string[] }> = [];
      const resolveClip = (name: string, clips: string[]): boolean => {
        if (clips.includes(name)) return true;
        const lower = name.toLowerCase();
        for (const c of clips) if (c.toLowerCase().includes(lower)) return true;
        return false;
      };
      for (const [scriptPath, src] of Object.entries(scripts)) {
        // Match against ANY binding for this script flat-name OR any
        // per-entity copy of it (`scripts/movement_foo_PlayerName.ts`).
        const baseName = scriptPath.replace(/_[A-Za-z0-9]+\.ts$/, '.ts');
        const bindings = behaviourBindings.get(scriptPath) ?? behaviourBindings.get(baseName);
        if (!bindings || bindings.length === 0) continue;
        const calls: string[] = [];
        let m: RegExpExecArray | null;
        while ((m = PLAY_ANIM_RE.exec(src)) !== null) calls.push(m[1]);
        PLAY_ANIM_RE.lastIndex = 0;
        if (calls.length === 0) continue;
        for (const binding of bindings) {
          for (const clipName of calls) {
            if (resolveClip(clipName, binding.clips)) continue;
            unresolved.push({
              script: scriptPath,
              entity: binding.entityName,
              clip: clipName,
              available: binding.clips,
            });
          }
        }
      }
      if (unresolved.length > 0) {
        const sample = unresolved.slice(0, 3).map(u =>
          `"${u.clip}" in ${u.script} on entity "${u.entity}" (available: ${u.available.slice(0, 8).join(', ')}${u.available.length > 8 ? ', …' : ''})`,
        ).join('; ');
        const more = unresolved.length > 3 ? ` (+${unresolved.length - 3} more)` : '';
        results.push({
          name: 'animation_clip_resolves',
          failure: new PlaytestFailure('animation_clip_unresolved',
            `${unresolved.length} \`entity.playAnimation("X", …)\` call${unresolved.length > 1 ? 's' : ''} reference${unresolved.length > 1 ? '' : 's'} clip names that don't exist on the bound GLB: ${sample}${more}. The engine's playAnimation silently no-ops on missing clips so the user sees "no animation" with no error. Fix: pick a clip name from the available list, or call \`bash library.sh animations <asset_path>\` to list valid clips for the chosen GLB.`,
            { unresolved: unresolved.slice(0, 20), total: unresolved.length }),
        });
      } else {
        results.push({ name: 'animation_clip_resolves', failure: null });
      }
    }
  }

  // ── 20. FSM action verbs are recognized by the fsm_driver ──────────
  // Iteration plan §1.2(A): unknown flow-action verbs (e.g. `show_hud`
  // instead of `show_ui:hud_panel`, `emit_game.X` instead of `emit:game.X`)
  // are silently dropped by fsm_driver._runAction — the state appears
  // to do nothing on enter/exit. Static check: every action string in
  // on_enter / on_exit / on_update / on_timeout matches one of the
  // verbs the driver recognizes; flag the rest with a Levenshtein
  // suggestion. Universal — every game has a flow.
  {
    const flow: any = p.runtime.files.flow;
    if (flow?.states) {
      // Bare-verb allowlist (no prefix).
      const BARE_VERBS = new Set([
        'show_cursor', 'hide_cursor', 'stop_music', 'stop_sound',
      ]);
      // Prefix verbs that take an argument after `:`.
      const PREFIX_VERBS = [
        'goto:', 'set:', 'increment:', 'emit:', 'mp:',
        'show_ui:', 'hide_ui:', 'notify:', 'play_sound:', 'play_music:',
        'set_timer:', 'random_action:',
      ];
      // Arithmetic forms: `VAR+5`, `VAR-$amount`. Any token of the form
      // `<word>[+-]<rest>` is accepted.
      const ARITH_RE = /^[A-Za-z_]\w*[+-].+$/;
      const recognize = (action: string): boolean => {
        if (typeof action !== 'string' || action.length === 0) return true;
        if (BARE_VERBS.has(action)) return true;
        for (const p of PREFIX_VERBS) if (action.startsWith(p)) return true;
        if (ARITH_RE.test(action)) return true;
        return false;
      };
      const unknown: Array<{ state: string; hook: string; action: string; suggest?: string }> = [];
      const allKnown = [...BARE_VERBS, ...PREFIX_VERBS.map(p => p.replace(/:$/, ''))];
      const editDistance = (a: string, b: string): number => {
        const m = a.length, n = b.length;
        if (m === 0) return n; if (n === 0) return m;
        const dp = new Array(n + 1).fill(0).map((_, j) => j);
        for (let i = 1; i <= m; i++) {
          let prev = i - 1;
          dp[0] = i;
          for (let j = 1; j <= n; j++) {
            const cur = dp[j];
            dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
            prev = cur;
          }
        }
        return dp[n];
      };
      const suggestFor = (verb: string): string | undefined => {
        let best: string | undefined; let bestD = Infinity;
        const head = verb.split(':')[0] || verb;
        for (const k of allKnown) {
          const d = editDistance(head.toLowerCase(), k.toLowerCase());
          if (d < bestD && d <= Math.max(2, Math.floor(k.length / 3))) { best = k; bestD = d; }
        }
        return best;
      };
      const walkVerbs = (states: Record<string, any> | undefined, prefix: string = ''): void => {
        if (!states) return;
        for (const [name, def] of Object.entries<any>(states)) {
          const fullName = prefix + name;
          for (const hook of ['on_enter', 'on_exit', 'on_update', 'on_timeout'] as const) {
            const list = def?.[hook];
            if (!Array.isArray(list)) continue;
            for (const action of list) {
              if (recognize(action)) continue;
              unknown.push({ state: fullName, hook, action, suggest: suggestFor(action) });
            }
          }
          if (def?.substates) walkVerbs(def.substates, fullName + '/');
        }
      };
      walkVerbs(flow.states);
      if (unknown.length > 0) {
        const sample = unknown.slice(0, 3).map(u =>
          `${u.state}.${u.hook}: "${u.action}"${u.suggest ? ` (did you mean "${u.suggest}:..."?)` : ''}`,
        ).join('; ');
        const more = unknown.length > 3 ? ` (+${unknown.length - 3} more)` : '';
        results.push({
          name: 'flow_action_verbs_known',
          failure: new PlaytestFailure('flow_unknown_verb',
            `${unknown.length} flow-action verb${unknown.length > 1 ? 's' : ''} not recognized by fsm_driver — silently dropped at runtime, the state will appear to do nothing: ${sample}${more}. Recognized verbs: bare \`show_cursor\`/\`hide_cursor\`/\`stop_music\`/\`stop_sound\`; prefixed \`goto:\`/\`set:\`/\`increment:\`/\`emit:\`/\`mp:\`/\`show_ui:\`/\`hide_ui:\`/\`notify:\`/\`play_sound:\`/\`play_music:\`/\`set_timer:\`/\`random_action:\`; arithmetic \`var+N\`/\`var-$key\`. Anything else is dropped.`,
            { unknown: unknown.slice(0, 20), total: unknown.length }),
        });
      } else {
        results.push({ name: 'flow_action_verbs_known', failure: null });
      }
    }
  }

  // ── 21. Every state is reachable from `start` ──────────────────────
  // Orphan states bloat the flow without affecting gameplay — usually
  // an authoring mistake (forgot to wire a transition into a tutorial
  // / cutscene state). Static BFS from flow.start; anything not reached
  // is an orphan.
  {
    const flow: any = p.runtime.files.flow;
    if (flow?.states && flow?.start) {
      // Build a flat map of stateName → state def, descending into substates.
      const allStates: Map<string, any> = new Map();
      const addStates = (states: Record<string, any>, prefix: string = ''): void => {
        for (const [name, def] of Object.entries<any>(states)) {
          const full = prefix + name;
          allStates.set(full, def);
          if (def?.substates) addStates(def.substates, full + '/');
        }
      };
      addStates(flow.states);
      // Resolve a transition target string (which may be a relative name,
      // sibling, or absolute path) against the flat map. Conservative:
      // try the literal first, then prefix-paths up the parent chain.
      const resolveTarget = (target: string, fromState: string): string | null => {
        if (allStates.has(target)) return target;
        // Try parent's siblings: strip last segment of fromState, append target.
        const parts = fromState.split('/');
        for (let i = parts.length - 1; i >= 0; i--) {
          const candidate = parts.slice(0, i).concat(target).join('/');
          if (allStates.has(candidate)) return candidate;
        }
        return null;
      };
      const reached = new Set<string>();
      const queue: string[] = [flow.start];
      // Compound start: also add the substate path if start.substates?.start exists.
      const startDef = allStates.get(flow.start);
      if (startDef?.substates && startDef?.start) queue.push(`${flow.start}/${startDef.start}`);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        if (reached.has(cur)) continue;
        reached.add(cur);
        const def = allStates.get(cur);
        if (!def) continue;
        // Compound state's start substate is implicitly reached.
        if (def.substates && def.start) {
          const subTarget = `${cur}/${def.start}`;
          if (allStates.has(subTarget) && !reached.has(subTarget)) queue.push(subTarget);
        }
        // Also reach all substates (so a goto to the parent then
        // substate transitions still find them).
        if (def.substates) {
          for (const subName of Object.keys(def.substates)) {
            const sub = `${cur}/${subName}`;
            if (allStates.has(sub) && !reached.has(sub)) queue.push(sub);
          }
        }
        for (const t of (def.transitions || []) as any[]) {
          const target = t?.goto;
          if (typeof target !== 'string') continue;
          const resolved = resolveTarget(target, cur);
          if (resolved && !reached.has(resolved)) queue.push(resolved);
        }
        // Also follow goto: actions in on_enter / on_exit etc.
        for (const hook of ['on_enter', 'on_exit', 'on_update', 'on_timeout'] as const) {
          const list = def?.[hook];
          if (!Array.isArray(list)) continue;
          for (const action of list) {
            if (typeof action !== 'string' || !action.startsWith('goto:')) continue;
            const target = action.substring(5);
            if (target === '_back') continue;
            const resolved = resolveTarget(target, cur);
            if (resolved && !reached.has(resolved)) queue.push(resolved);
          }
        }
      }
      const orphans: string[] = [];
      for (const name of allStates.keys()) {
        if (reached.has(name)) continue;
        // Ignore substates whose parent itself was unreachable — only
        // the parent counts as the "real" orphan; child noise is a
        // distraction.
        const slashIdx = name.lastIndexOf('/');
        if (slashIdx > 0) {
          const parent = name.substring(0, slashIdx);
          if (!reached.has(parent)) continue;
        }
        orphans.push(name);
      }
      if (orphans.length > 0) {
        const sample = orphans.slice(0, 5).join(', ');
        const more = orphans.length > 5 ? ` (+${orphans.length - 5} more)` : '';
        results.push({
          name: 'flow_states_reachable',
          failure: new PlaytestFailure('flow_orphan_state',
            `${orphans.length} state${orphans.length > 1 ? 's' : ''} unreachable from flow.start ("${flow.start}"): ${sample}${more}. The state exists in 01_flow.json but no transition or goto: action ever leads to it. Either wire a transition INTO the state from somewhere on the reachable graph, or remove the state.`,
            { orphans: orphans.slice(0, 20), start: flow.start, total: orphans.length }),
        });
      } else {
        results.push({ name: 'flow_states_reachable', failure: null });
      }
    }
  }

  // ── 22. Non-terminal states have at least one exit transition ──────
  // Dead-end states trap the player: they enter and can never leave.
  // Treat states whose name implies "this is the end" as terminal
  // (game_over, victory, level_complete, results, end, finish) — those
  // are allowed to have no exit.
  {
    const flow: any = p.runtime.files.flow;
    if (flow?.states) {
      const TERMINAL_RE = /^(game_over|victory|defeat|results|summary|level_complete|completed|finish(ed)?|end|exit|quit|credits|cutscene_end)$/i;
      const deadEnds: string[] = [];
      const walk = (states: Record<string, any>, prefix: string = ''): void => {
        for (const [name, def] of Object.entries<any>(states)) {
          const full = prefix + name;
          // Terminal-by-name → allowed to have no exit.
          if (TERMINAL_RE.test(name)) {
            if (def?.substates) walk(def.substates, full + '/');
            continue;
          }
          const transitions = Array.isArray(def?.transitions) ? def.transitions : [];
          // Also count goto: actions in on_enter / on_exit / on_update / on_timeout.
          let hasGotoAction = false;
          for (const hook of ['on_enter', 'on_exit', 'on_update', 'on_timeout'] as const) {
            const list = def?.[hook];
            if (!Array.isArray(list)) continue;
            for (const a of list) {
              if (typeof a === 'string' && a.startsWith('goto:')) { hasGotoAction = true; break; }
            }
            if (hasGotoAction) break;
          }
          // Compound states with a `start` substate route through the
          // child — they're not dead-ends from the player's perspective.
          const hasSubStart = def?.substates && def?.start;
          if (transitions.length === 0 && !hasGotoAction && !hasSubStart) {
            deadEnds.push(full);
          }
          if (def?.substates) walk(def.substates, full + '/');
        }
      };
      walk(flow.states);
      if (deadEnds.length > 0) {
        const sample = deadEnds.slice(0, 5).join(', ');
        const more = deadEnds.length > 5 ? ` (+${deadEnds.length - 5} more)` : '';
        results.push({
          name: 'flow_states_have_exit',
          failure: new PlaytestFailure('flow_dead_end_state',
            `${deadEnds.length} non-terminal state${deadEnds.length > 1 ? 's' : ''} with no exit transition — player gets stuck once they enter: ${sample}${more}. Add at least one \`transitions: [{ when: "...", goto: "..." }]\` entry, or rename to a terminal name (game_over / victory / level_complete / etc.) if it really is the end of the session.`,
            { deadEnds: deadEnds.slice(0, 20), total: deadEnds.length }),
        });
      } else {
        results.push({ name: 'flow_states_have_exit', failure: null });
      }
    }
  }

  // ── 23. System init from on_enter timing trap ──────────────────────
  // Documented in CREATOR_CONTEXT but unenforced. Pattern: a state's
  // on_enter emits `game.X` AND the state's active_systems contains a
  // system whose onStart registers a listener for `game.X`. The system
  // activates and emits go in the same frame; the listener registers
  // AFTER the emit fires → event lost forever, the system's
  // first-time init never runs. Symptom: "match never starts," "boss
  // never spawns," etc.
  {
    const flow: any = p.runtime.files.flow;
    const systemsJson: any = p.runtime.files.systems;
    const projScripts: Record<string, string> = p.runtime.projectScripts ?? p.runtime.files.scripts ?? {};
    // 04_systems.json shape is `{ systems: { name: { script, params } } }`.
    const systemDefs: Record<string, any> = (systemsJson?.systems && typeof systemsJson.systems === 'object')
      ? systemsJson.systems
      : (systemsJson && typeof systemsJson === 'object' ? systemsJson : {});
    if (flow?.states && Object.keys(systemDefs).length > 0 && Object.keys(projScripts).length > 0) {
      // Build (systemKey → script-source-text) by joining systemsJson
      // entries to the assembled script file. The assembler flattens
      // `systems/gameplay/foo.ts` into `scripts/gameplay_foo.ts`.
      const systemSrc: Map<string, string> = new Map();
      for (const [sysName, sysDef] of Object.entries<any>(systemDefs)) {
        const scriptRef: string | undefined = sysDef?.script;
        if (!scriptRef) continue;
        const flat = 'scripts/' + scriptRef.replace(/\//g, '_');
        const src = projScripts[flat];
        if (src) systemSrc.set(sysName, src);
      }
      // Extract events listened-for in onStart() body. Conservative:
      // brace-depth scan from `onStart(` to its closing `}`, then grep
      // events.game.on inside.
      const onStartListeners = (src: string): Set<string> => {
        const out = new Set<string>();
        const idx = src.search(/(?<![.\w])onStart\s*\(/);
        if (idx < 0) return out;
        const open = src.indexOf('{', idx);
        if (open < 0) return out;
        let depth = 1, i = open + 1;
        while (i < src.length && depth > 0) {
          const ch = src[i];
          if (ch === '"' || ch === "'" || ch === '`') {
            const q = ch; i++;
            while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; i++; }
            i++; continue;
          }
          if (ch === '{') depth++;
          else if (ch === '}') depth--;
          i++;
        }
        const body = src.slice(open + 1, i - 1);
        const re = /events\.game\.on\s*\(\s*['"]([^'"]+)['"]/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) out.add(m[1]);
        return out;
      };
      // Reset-style event names are deliberately re-fired on every
      // gameplay-enter to drive the same reset/respawn code path. Their
      // first-time init lives in class-field initializers, so the
      // first emit landing in a void is by design — only the SECOND+
      // entry (Play Again) needs the listener. Filter these to avoid
      // flagging the canonical replay/reset pattern.
      const RESET_EVENT_RE = /(restart|reset|respawn|new_round|new_game|new_match|round_start|level_start|wave_start)/i;
      const traps: Array<{ state: string; system: string; event: string }> = [];
      const walk = (states: Record<string, any>, prefix: string = ''): void => {
        for (const [name, def] of Object.entries<any>(states)) {
          const full = prefix + name;
          const onEnter: any[] = Array.isArray(def?.on_enter) ? def.on_enter : [];
          const emitted = new Set<string>();
          for (const a of onEnter) {
            if (typeof a !== 'string') continue;
            const m = a.match(/^emit:game\.(\w+)/);
            if (m && !RESET_EVENT_RE.test(m[1])) emitted.add(m[1]);
          }
          if (emitted.size > 0) {
            const activeSystems: any[] = Array.isArray(def?.active_systems) ? def.active_systems : [];
            for (const sysName of activeSystems) {
              if (typeof sysName !== 'string') continue;
              const src = systemSrc.get(sysName);
              if (!src) continue;
              const listens = onStartListeners(src);
              for (const evt of emitted) {
                if (listens.has(evt)) traps.push({ state: full, system: sysName, event: evt });
              }
            }
          }
          if (def?.substates) walk(def.substates, full + '/');
        }
      };
      walk(flow.states);
      if (traps.length > 0) {
        const sample = traps.slice(0, 3).map(t => `state "${t.state}" emits "${t.event}" in on_enter while activating system "${t.system}" whose onStart registers \`events.game.on("${t.event}", ...)\``).join('; ');
        const more = traps.length > 3 ? ` (+${traps.length - 3} more)` : '';
        results.push({
          name: 'system_init_no_timing_trap',
          failure: new PlaytestFailure('flow_init_timing_trap',
            `${traps.length} on_enter init-event timing trap${traps.length > 1 ? 's' : ''}: ${sample}${more}. The FSM activates the system and fires the emit in the same frame, but the system's listener is registered later by onStart — the emit fires into a void and the system's first-time init never runs. Fix: either (a) move the system's first-time init OUT of the listener and into onStart() directly, or (b) emit the event from a transition's actions instead of the destination state's on_enter (so the system's onStart fires first).`,
            { traps: traps.slice(0, 20), total: traps.length }),
        });
      } else {
        results.push({ name: 'system_init_no_timing_trap', failure: null });
      }
    }
  }

  return results;
}

/**
 * Lazy-load the pre-baked GLB clip manifest. Path: sibling
 * engine/backend/data/glb_clip_manifest.json. Cached after first read
 * because the file is ~378KB and re-parsing per playtest is wasteful.
 * Returns null if the manifest hasn't been built — the invariant
 * silently skips in that case so dev environments without the
 * manifest don't false-fail.
 */
let _glbClipManifestCache: Record<string, { clips: string[] }> | null = null;
let _glbClipManifestTried = false;
function loadGlbClipManifest(): Record<string, { clips: string[] }> | null {
  if (_glbClipManifestCache) return _glbClipManifestCache;
  if (_glbClipManifestTried) return null;
  _glbClipManifestTried = true;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    // engine/headless/src/invariants.ts → engine/backend/data/glb_clip_manifest.json
    // here = engine/headless/src; ..= engine/headless; ../.. = engine
    const manifestPath = path.resolve(here, '..', '..', 'backend', 'data', 'glb_clip_manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const raw = fs.readFileSync(manifestPath, 'utf-8');
    _glbClipManifestCache = JSON.parse(raw);
    return _glbClipManifestCache;
  } catch {
    return null;
  }
}

/** Extract keybind hints from raw HUD HTML. Looks for two patterns:
 *   1. `<span class="kbd">X</span>\s*Y`  → ('X', 'Y')
 *   2. `Press\s+X\s+to\s+Y` / `Press\s+X`  → ('X', 'Y'?)
 * Returns `{ key, context }` where `key` is the label found in the HUD
 * (which may be "P", "Space", "Shift", etc.) and `context` is a short
 * fragment for the error message. */
function extractKeyHints(html: string): Array<{ key: string; context: string }> {
  const out: Array<{ key: string; context: string }> = [];
  // Pattern 1: kbd span — the most common convention in pinned UI panels.
  const kbdRe = /<span[^>]*class=["']([^"']*\bkbd\b[^"']*)["'][^>]*>\s*([^<]+?)\s*<\/span>\s*([A-Za-z][A-Za-z\s]{0,20})/g;
  let m: RegExpExecArray | null;
  while ((m = kbdRe.exec(html)) !== null) {
    const key = m[2].trim();
    const action = m[3].trim().split(/\s+/).slice(0, 3).join(' ');
    if (key.length > 0 && key.length <= 20) {
      out.push({ key, context: `${key} ${action}`.trim() });
    }
  }
  // Pattern 2: "Press X to Y" / "Press X"
  const pressRe = /Press\s+([A-Za-z][A-Za-z0-9]{0,10})(?:\s+to\s+([A-Za-z][A-Za-z\s]{0,20}))?/gi;
  while ((m = pressRe.exec(html)) !== null) {
    const key = m[1].trim();
    const action = (m[2] ?? '').trim().split(/\s+/).slice(0, 3).join(' ');
    out.push({ key, context: `Press ${key}${action ? ' to ' + action : ''}` });
  }
  return out;
}

/** Map a HUD label like "P", "Space", "Shift" to a DOM `code` like "KeyP".
 * Returns null for labels we don't recognise (e.g. a stray word picked up
 * by the regex) — unknown labels are skipped rather than failing the test. */
function keyLabelToCode(label: string): string | null {
  const s = label.trim();
  if (s.length === 1) {
    const c = s.toUpperCase();
    if (c >= 'A' && c <= 'Z') return `Key${c}`;
    if (c >= '0' && c <= '9') return `Digit${c}`;
  }
  const lower = s.toLowerCase();
  const map: Record<string, string> = {
    'space': 'Space',
    'spacebar': 'Space',
    'enter': 'Enter',
    'return': 'Enter',
    'shift': 'ShiftLeft',
    'ctrl': 'ControlLeft',
    'control': 'ControlLeft',
    'alt': 'AltLeft',
    'tab': 'Tab',
    'esc': 'Escape',
    'escape': 'Escape',
    'up': 'ArrowUp',
    'down': 'ArrowDown',
    'left': 'ArrowLeft',
    'right': 'ArrowRight',
  };
  return map[lower] ?? null;
}

function guarded(name: string, fn: () => void): InvariantResult {
  try { fn(); return { name, failure: null }; }
  catch (e: any) {
    if (e instanceof PlaytestFailure) return { name, failure: e };
    return { name, failure: new PlaytestFailure('internal', String(e?.message ?? e)) };
  }
}
