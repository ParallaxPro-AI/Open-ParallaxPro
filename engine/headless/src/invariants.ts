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
      const btns = p.runtime.ui.listVisible().filter(el => el.kind === 'button' || el.kind === 'textInput');
      if (btns.length === 0) {
        throw new PlaytestFailure('ui_unreachable',
          `gameType=${gameType} but no visible clickable UI element exists after 5 ticks.`,
          { hint: 'Create at least one scene.createButton({ x, y, width, height, text, onClick }) in a system onStart, or declare clickable UI in an HTML panel opened via show_ui.' });
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
      const tags = e.tags instanceof Set ? Array.from(e.tags) : (Array.isArray(e.tags) ? e.tags : []);
      if (tags.includes('ui') || tags.includes('camera') || tags.includes('decoration_only') || tags.includes('no_collide') || tags.includes('particle') || tags.includes('vfx')) continue;
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
      const names = missing.slice(0, 5).map(m => `"${m.name}" (${m.reason})`).join(', ');
      const more = missing.length > 5 ? ` (+${missing.length - 5} more)` : '';
      throw new PlaytestFailure('interactive_no_collider',
        `${missing.length} entit${missing.length > 1 ? 'ies' : 'y'} lack colliders: ${names}${more}. The player's physics will pass straight through these. Most likely cause: you set \`physics: false\` on the entity in 02_entities.json. Either give them a physics block (\`physics: { type: "static", collider: "box" }\` for walls/obstacles, \`physics: { type: "static", collider: { shape: "box" }, is_trigger: true }\` for pickups/zones), OR add the tag \`"decoration_only"\` if they truly are non-collidable decoration.`,
        { missing: missing.slice(0, 10), total: missing.length });
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
  const PICKUP_NAME_RE = /^(pickup|coin|collectable|collectible|gem|powerup|crystal|star|fruit|apple|cookie|orb|rune|key|potion|heart|health|mushroom|flower|sun_blob)/i;
  const findPickups = () => [...(p.runtime.scene?.entities.values() ?? [])].filter((e: any) => {
    if (!e.active) return false;
    if (PICKUP_NAME_RE.test(e.name)) return true;
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
    for (const [stateName, stateDef] of Object.entries<any>(flow.states)) {
      if (stateName === 'boot') continue;
      const onEnter: string[] = Array.isArray(stateDef.on_enter) ? stateDef.on_enter : [];
      const opensUI = onEnter.some(op => typeof op === 'string' && /^show_ui:/.test(op));
      const hasShowCursor = onEnter.some(op => typeof op === 'string' && /^show_cursor\b/.test(op));
      const hasHideCursor = onEnter.some(op => typeof op === 'string' && /^hide_cursor\b/.test(op));
      if (hasShowCursor) anyStateShowsCursor = true;
      if (opensUI && !hasShowCursor && !hasHideCursor) {
        cursorlessClickableStates.push({ state: stateName, reason: 'opens UI but no show_cursor in on_enter' });
      }
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
        if (p.runtime.scriptScene?.events?.game?.emit) {
          p.runtime.scriptScene.events.game.emit(endEvent, {});
        }
        p.tick(30);
        const gameOverFrame = p.frameCount() - 30;
        const post = p.eventsFired({ channel: 'ui', name: 'hud_update', sinceFrame: gameOverFrame + 1 });
        const scoreHudUpdates = post.filter(e => {
          const d = e.data;
          if (!d || typeof d !== 'object') return false;
          return Object.keys(d).some(k => SCORE_LIKE_KEY_RE.test(k));
        });
        if (scoreHudUpdates.length >= 10) {
          flickerDetected = {
            endEvent,
            count: scoreHudUpdates.length,
            sampleKeys: scoreHudUpdates[0]?.data ? Object.keys(scoreHudUpdates[0].data) : [],
          };
        }
      } catch {}
      p.restore(snap);
    }
    if (flickerDetected) {
      results.push({
        name: 'hud_stops_after_game_over',
        failure: new PlaytestFailure('hud_keeps_updating',
          `${flickerDetected.count} \`ui.hud_update\` events with a score-like key fired AFTER \`${flickerDetected.endEvent}\` — the HUD system keeps pushing live score while the end-screen modal animates a final score to the same DOM element. The two writes fight and the display flickers. Fix: in the gameplay system, listen for \`${flickerDetected.endEvent}\` (or whichever end event your game uses) and set \`this._ended = true\`, then guard the hud_update emission with \`if (this._ended) return;\`. Non-score keys (speed, gear, health) don't flicker and can keep emitting.`,
          {
            endEvent: flickerDetected.endEvent,
            postEndUpdates: flickerDetected.count,
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
  if (gameType === 'shooter' || gameType === 'first_person') {
    if (player) {
      const playerE: any = p.runtime.scene?.entities.get(player.id);
      const mr: any = playerE?.getComponent('MeshRendererComponent');
      if (mr && mr.meshAsset && !mr.hideFromOwner) {
        // Rule: ANY player-tagged entity with a visible mesh in a
        // shooter/first_person game must set hideFromOwner. The earlier
        // check required the camera to be a scene-graph descendant of
        // the player — but the common pattern is a SEPARATE camera
        // entity with a behavior (fps_camera) that snaps to the player's
        // position every frame. No parent relationship in the graph, so
        // the descendant walk missed it, and run 43744221 shipped with
        // the full Soldier_Male.glb visible through the first-person
        // camera. Genre alone is sufficient — if it's an FPS and the
        // player has a mesh, hide it from the owner.
        results.push({
          name: 'fps_hides_own_mesh',
          failure: new PlaytestFailure('own_mesh_visible',
            `player entity "${playerE.name}" has a visible mesh (asset=${mr.meshAsset}) but \`hideFromOwner\` is not set. In a ${gameType} game the camera sits at the player's head — the player sees their own model's interior, elbows, and neck stump. Fix: add \`hideFromOwner: true\` to the player entity's mesh data in 02_entities.json:\n    "mesh": { "type": "custom", "asset": "${mr.meshAsset}", "hideFromOwner": true }\nOther cameras (spectator, multiplayer peer views) still see the mesh — the flag only hides from the owning camera.`,
            { playerMesh: mr.meshAsset, player: playerE.name, gameType }),
        });
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
        // halfExtents / primitive ratio is independent of scale (scale
        // applies equally to both mesh-size and collider-size at runtime),
        // so comparing halfExtents against the primitive unit tells us
        // "how much bigger/smaller is the collider than its mesh."
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
        // where wall_block had ratios [4, 4, 1].
        const badAxes: Array<{ axis: string; ratio: number; col: number; prim: number }> = [];
        if (rx > 2 || rx < 0.5) badAxes.push({ axis: 'x', ratio: rx, col: cx, prim: prim.x });
        if (ry > 2 || ry < 0.5) badAxes.push({ axis: 'y', ratio: ry, col: cy, prim: prim.y });
        if (rz > 2 || rz < 0.5) badAxes.push({ axis: 'z', ratio: rz, col: cz, prim: prim.z });
        if (badAxes.length >= 2) {
          const worst = badAxes.reduce((a, b) => Math.abs(Math.log(a.ratio)) > Math.abs(Math.log(b.ratio)) ? a : b);
          mismatches.push({ name: entName, axis: worst.axis, ratio: worst.ratio, meshHalf: worst.prim, colHalf: worst.col });
        }
      }
      if (mismatches.length > 0) {
        results.push({
          name: 'collider_matches_mesh_scale',
          failure: new PlaytestFailure('collider_size_mismatch',
            `${mismatches.length} entit${mismatches.length > 1 ? 'ies have' : 'y has'} colliders whose effective size disagrees with the mesh by more than 2×: ${mismatches.slice(0, 5).map(m => `"${m.name}" (${m.axis}: collider=${m.colHalf.toFixed(2)} vs mesh=${m.meshHalf.toFixed(2)}, ${m.ratio.toFixed(1)}×)`).join(', ')}. The engine multiplies collider halfExtents by transform.scale at runtime — if you authored halfExtents as world-space target sizes rather than pre-scale fractions, they'll be too big. Fix: for a primitive mesh at scale=[W,H,D], use halfExtents=[0.5,0.5,0.5] for cube (not [W/2, H/2, D/2]). The engine's scale multiply does the rest.`,
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
    if (!hasPinnedSeparation) {
      for (const [file, src] of scriptEntries) {
        // Signal: calls setVelocity toward a player target inside a per-
        // frame update, no separation force loop.
        if (!/findEntityByName\(["']Player["']\)|findEntitiesByTag\(["']player["']\)/.test(src)) continue;
        if (!/setVelocity\s*\(/.test(src)) continue;
        // Negative: if the source loops over same-tag neighbors and does
        // (pos.x - other.pos.x) separation math, we consider it already
        // safe.
        const hasSepLoop = /findEntitiesByTag\([^)]*\)[\s\S]{0,200}(sep|repuls|personal)/i.test(src);
        if (hasSepLoop) continue;
        // Only flag if it clearly looks like AI (robot/enemy/zombie/…).
        if (!/robot|enemy|zombie|ghost|goomba|skeleton|orc|minion|drone|npc/i.test(file + '\n' + src)) continue;
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
          `${smells.length} hand-rolled behavior${smells.length > 1 ? 's' : ''} duplicate${smells.length > 1 ? '' : 's'} functionality of pinned library files and usually miss subtleties the pinned versions handle: ${smells.map(s => `${s.file} → use ${s.suggestedLibrary} (${s.why})`).join('; ')}. Fix: \`bash library.sh show ${smells[0].suggestedLibrary}\` to fetch the pinned source, write it into project/behaviors/<path>, and reference it from your entity / system definitions instead of the inline motion.`,
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
    const placements = (p.runtime.files.worlds?.worlds ?? []).flatMap((w: any) => (w.placements ?? []));
    const placed = new Set<string>(placements.map((pl: any) => pl.ref).filter(Boolean));
    const allScripts = Object.values(p.runtime.files.scripts ?? {}).join('\n');
    const orphans: string[] = [];
    for (const name of Object.keys(defs)) {
      if (placed.has(name)) continue;
      if (!GAMEPLAY_NAME_RE.test(name)) continue;  // only flag gameplay-named ones
      // Look for spawnEntity("name") / hasPrefab("name") / createEntity("name") in any script source.
      const q1 = `spawnEntity("${name}")`;
      const q2 = `spawnEntity('${name}')`;
      const q3 = `hasPrefab("${name}")`;
      const q4 = `createEntity("${name}")`;
      if (allScripts.includes(q1) || allScripts.includes(q2) || allScripts.includes(q3) || allScripts.includes(q4)) {
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
          `${orphans.length} gameplay-named prefab${orphans.length > 1 ? 's are' : ' is'} declared in 02_entities.json but never placed in 03_worlds.json and never materialize at runtime via spawnEntity: ${orphans.slice(0, 5).map(n => `"${n}"`).join(', ')}${orphans.length > 5 ? ` (+${orphans.length - 5} more)` : ''}. Either add placements for them in 03_worlds.json, OR write a spawner system that calls \`scene.spawnEntity("${orphans[0]}")\` from active_systems during the gameplay state. If the spawner system exists but they're still absent after 3s of ticks, check the spawner's active_behaviors/active_systems gating and its spawn coordinates — the robots in run 502bd348 had a spawner registered but spawned outside the visible play area.`,
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
    // `_emitBus("game", "<name>", ...)` helper.
    const SCRIPT_EMIT_RE_1 = /events\.game\.emit\s*\(\s*["']([^"']+)["']/g;
    const SCRIPT_EMIT_RE_2 = /_emitBus\s*\(\s*["']game["']\s*,\s*["']([^"']+)["']/g;
    for (const src of Object.values(scripts)) {
      let m: RegExpExecArray | null;
      SCRIPT_EMIT_RE_1.lastIndex = 0;
      while ((m = SCRIPT_EMIT_RE_1.exec(src)) !== null) emittedEvents.add(m[1]);
      SCRIPT_EMIT_RE_2.lastIndex = 0;
      while ((m = SCRIPT_EMIT_RE_2.exec(src)) !== null) emittedEvents.add(m[1]);
    }

    // Listeners — scan non-transport scripts for `events.game.on(...)`.
    // Same assembler-flattened path shape as the advertised_keys
    // invariant uses (`scripts/ui_ui_bridge.ts`, not `systems/ui/ui_bridge.ts`).
    const TRANSPORT_RE = /(^|[\/_])(ui_bridge|mp_bridge|fsm_driver|_entity_label|event_definitions|_event_validator)(_[^/]*)?\.ts$/;
    const LISTEN_RE = /events\.game\.on\s*\(\s*["']([^"']+)["']/g;
    const deadListeners: Array<{ name: string; script: string }> = [];
    const seen = new Set<string>();
    for (const [scriptPath, src] of Object.entries(scripts)) {
      if (TRANSPORT_RE.test(scriptPath)) continue;
      LISTEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = LISTEN_RE.exec(src)) !== null) {
        const evtName = m[1];
        if (emittedEvents.has(evtName)) continue;
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
          `${deadListeners.length} script listener${deadListeners.length > 1 ? 's' : ''} registered for game events nothing emits: ${first}${more}. Either rename the listener to match an event that IS emitted (grep "emit:game." in 01_flow.json and "events.game.emit" in other scripts for the canonical name — most commonly "restart_game" for play-again resets), OR add the emit from a flow transition / system where the event should originate. Silent no-op listeners are the #1 cause of "works first time but not after replay" bugs.`,
          { deadListeners }),
      });
    } else {
      results.push({ name: 'behavior_listens_for_unemitted_event', failure: null });
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
