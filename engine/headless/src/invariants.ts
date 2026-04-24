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
            throw new PlaytestFailure('controls_dead',
              `holding "${primaryAction}" for 1s moved player ${d.toFixed(3)} units. Controls appear unwired.`,
              { primaryAction, moved: d });
          }
        }));
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
  const uiHtmls = p.runtime.files.uiHtmls ?? {};
  if (Object.keys(uiHtmls).length > 0) {
    const deadKeys: Array<{ key: string; source: string; context: string }> = [];
    const seen = new Set<string>();
    const SKIP_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'MouseLeft', 'MouseRight', 'MouseMiddle', 'Escape', 'Tab']);
    for (const [path, html] of Object.entries<string>(uiHtmls)) {
      const hints = extractKeyHints(html);
      for (const hint of hints) {
        const code = keyLabelToCode(hint.key);
        if (!code || SKIP_KEYS.has(code) || seen.has(code)) continue;
        seen.add(code);
        const snap = p.snapshot();
        const fsmBefore = p.fsmState();
        const stateBefore = JSON.stringify(p.getState() ?? {});
        const entitiesBefore = p.list().length;
        try {
          p.activateAllBehaviors();
          p.tapKey(code, 100);
          p.tick(20);
          const fsmAfter = p.fsmState();
          const stateAfter = JSON.stringify(p.getState() ?? {});
          const entitiesAfter = p.list().length;
          const fsmChanged = fsmBefore !== fsmAfter;
          const stateChanged = stateBefore !== stateAfter;
          const entityCountChanged = entitiesBefore !== entitiesAfter;
          if (!fsmChanged && !stateChanged && !entityCountChanged) {
            deadKeys.push({ key: code, source: path, context: hint.context });
          }
        } catch {
          // Errors during key simulation don't count as "dead" — the key at
          // least did something (crashed). The script_health invariant will
          // pick that up separately.
        }
        p.restore(snap);
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

  return results;
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
