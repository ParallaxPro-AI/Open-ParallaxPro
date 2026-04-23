/**
 * Tier-1 invariants — checks that apply to every game, derived from the live
 * REAL-engine scene state. Catches the majority of CREATE_GAME failure modes
 * that slip past the assembler (player stuck inside geometry at spawn,
 * missing ground collider, dead controls, onUpdate crashes, unreachable UI).
 */

import { Playtest, PlaytestFailure, EntityRef } from './playtest.js';

export interface InvariantResult {
  name: string;
  failure: PlaytestFailure | null;
  skipped?: boolean;
  skipReason?: string;
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
    results.push(guarded('spawn_not_overlapping', () => { p.assertNotStuck(playerEarly); }));
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
    const snap = p.snapshot();
    const before = p.pos(player);
    if (before) {
      try {
        p.tick(120);  // ~2 seconds
        const fallThreshold = Math.min(before.y - 3, -5);
        results.push(guarded('ground_holds_player', () => { p.assertYAbove(player, fallThreshold); }));
        results.push(guarded('script_health_runtime', () => { p.assertNoErrors(); }));
        results.push(guarded('no_nan_position', () => { p.assertPositionNotNaN(player); }));
      } catch (e: any) {
        results.push({ name: 'ground_holds_player', failure: e instanceof PlaytestFailure ? e : new PlaytestFailure('tick_crash', String(e?.message ?? e)) });
      }
      p.restore(snap);
    }

    // ── 5. Responsiveness: hold primary action, something should change.
    if (primaryAction && ['locomotion_3d', 'vehicle', 'platformer', 'shooter'].includes(gameType)) {
      const snap2 = p.snapshot();
      const beforeP = p.pos(player);
      // Real games gate behavior scripts on FSM gameplay state — the
      // FSM driver emits `active_behaviors` per state. For an automated
      // "could the user play this?" check we short-circuit the FSM and
      // force all behaviors on so onUpdate actually runs.
      p.activateAllBehaviors();
      try {
        p.keyDown(primaryAction);
        p.tickSeconds(1);
        p.keyUp(primaryAction);
        results.push(guarded('primary_action_responsive', () => {
          const afterP = p.pos(player);
          if (!beforeP || !afterP) return;
          const dx = afterP.x - beforeP.x, dy = afterP.y - beforeP.y, dz = afterP.z - beforeP.z;
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (d < 0.1) {
            throw new PlaytestFailure('controls_dead',
              `holding "${primaryAction}" for 1s moved player ${d.toFixed(3)} units. Controls appear unwired.`,
              { primaryAction, moved: d });
          }
        }));
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

  // ── 7. UI has at least one clickable element for UI-dominant games ──
  if (['ui', 'clicker', 'paddle_2d', 'board'].includes(gameType)) {
    results.push(guarded('ui_has_interactable', () => {
      const btns = p.runtime.ui.listVisible().filter(el => el.kind === 'button' || el.kind === 'textInput');
      if (btns.length === 0) {
        throw new PlaytestFailure('ui_unreachable',
          `gameType=${gameType} but no visible clickable UI element exists after 5 ticks.`,
          { hint: 'Create at least one scene.createButton({ x, y, width, height, text, onClick }) in a system onStart.' });
      }
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

  return results;
}

function guarded(name: string, fn: () => void): InvariantResult {
  try { fn(); return { name, failure: null }; }
  catch (e: any) {
    if (e instanceof PlaytestFailure) return { name, failure: e };
    return { name, failure: new PlaytestFailure('internal', String(e?.message ?? e)) };
  }
}
