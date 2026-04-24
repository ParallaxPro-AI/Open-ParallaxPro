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
    const INTERACTIVE_NAME_RE = /^(wall|ramp|fence|boundary|barrier|obstacle|pickup|coin|collectable|collectible|hazard|enemy|trap|pillar|platform|block|brick|stair|floor|rock|asteroid|boulder|tree|bush|plant|door|gate|key|potion|apple|fruit|health|shield|crate|barrel|shelf|bumper|pad|bomb|mine|tower|turret|zombie|robot|goomba|orc|goblin|skeleton|slime|drone|ufo|ship|pin|target|flag|checkpoint|finish|gem|crystal|star|orb|rune|cookie|powerup|trap|spike|lava|wall_.*|fence_.*|rock_.*|enemy_.*|robot_.*|.*_wall|.*_ramp|.*_pickup|.*_coin|.*_fence|.*_boundary|.*_hazard|.*_obstacle|.*_rock|.*_enemy|.*_target)$/i;
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
        // Check if the camera is on the same entity or parented under it.
        const cam = discoverCamera(p);
        let cameraOwnedByPlayer = false;
        if (cam) {
          const camE: any = p.runtime.scene?.entities.get(cam.id);
          let cur: any = camE;
          while (cur) {
            if (cur.id === player.id) { cameraOwnedByPlayer = true; break; }
            cur = cur.parent ?? null;
          }
        }
        if (cameraOwnedByPlayer) {
          results.push({
            name: 'fps_hides_own_mesh',
            failure: new PlaytestFailure('own_mesh_visible',
              `player entity "${playerE.name}" has a visible mesh (asset=${mr.meshAsset}) AND the active camera is on the same entity or a child of it, but \`hideFromOwner\` is not set. In first-person view the player will see their own model's inside, elbows, nose, and neck stump. Fix: add \`hideFromOwner: true\` to the player entity's mesh data in 02_entities.json:\n    "mesh": { "type": "custom", "asset": "${mr.meshAsset}", "hideFromOwner": true }\nOther cameras (spectator, multiplayer peer views) still see the mesh — the flag only hides from the owning camera.`,
              { playerMesh: mr.meshAsset, player: playerE.name }),
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
