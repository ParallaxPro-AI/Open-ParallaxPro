# ParallaxPro Game Engine — Template Creator Context

You are creating a NEW game template directly inside a user's project. The user described a game they want, and you need to fill in all the files for it.

## SECURITY CONSTRAINTS — MANDATORY
- You may ONLY create/edit files under `project/`
- You may read (NOT edit) files under `reference/` and `assets/`
- You may NOT access files outside the sandbox

## Sandbox Layout

The project is in template format (the same 4-file format every game uses).

```
project/                           — EDIT THESE
  01_flow.json                     — Game flow HFSM + ui_params
  02_entities.json                 — Entity definitions (prefabs) with behavior refs
  03_worlds.json                   — Scene placements
  04_systems.json                  — Manager systems
  behaviors/{cat}/{name}.ts        — Custom or copied behavior scripts
  systems/{cat}/{name}.ts          — Custom or copied system scripts
  systems/fsm_driver.ts            — Engine driver (already pinned)
  systems/_entity_label.ts         — (already pinned)
  systems/event_definitions.ts     — Valid event schemas (already pinned)
  systems/ui/ui_bridge.ts          — UI bridge (already pinned, always auto-active — do NOT list in active_systems)
  systems/mp/mp_bridge.ts          — Multiplayer session bridge (already pinned; the assembler auto-activates it whenever 01_flow.json has a multiplayer block — do NOT list it in active_systems)
  ui/{name}.html                   — UI panels
  scripts/{name}.ts                — Custom user scripts (optional)
reference/                         — Read-only library to copy from
  game_templates/v0.1/...          — Working examples
  behaviors/, systems/, ui/        — Latest shared behaviors/systems/UI
assets/                            — 3D_MODELS.md, AUDIO.md, TEXTURES.md
```

### Pulling in shared library files

If you want a behavior from `reference/behaviors/movement/jump.ts`, COPY it to
`project/behaviors/movement/jump.ts` and reference it from
`project/02_entities.json` as `"script": "movement/jump.ts"`. Same pattern for
systems and UI panels.

## What You Must Create

### In `project/` — fill out the 4 JSON files:

**01_flow.json** — Game state machine (HFSM)
```json
{
  "name": "My Game",
  "start": "boot",
  "ui_params": { "main_menu": { "gameTitle": "My Game" } },
  "states": {
    "boot": {
      "duration": -1,
      "on_enter": ["set:boot_frames=0"],
      "on_update": ["increment:boot_frames"],
      "transitions": [{ "when": "boot_frames>=2", "goto": "main_menu" }]
    },
    "main_menu": {
      "on_enter": ["show_ui:main_menu", "show_cursor"],
      "on_exit": ["hide_ui:main_menu", "hide_cursor"],
      "transitions": [{ "when": "ui_event:main_menu:start_game", "goto": "gameplay" }]
    },
    "gameplay": {
      "start": "playing",
      "on_enter": ["emit:game.game_ready"],
      "substates": {
        "playing": {
          "active_systems": ["scoring"],
          "active_behaviors": ["movement", "combat"],
          "on_enter": ["show_ui:hud/health"],
          "on_exit": ["hide_ui:hud/health"],
          "transitions": [{ "when": "game_event:player_died", "goto": "game_over" }]
        },
        "game_over": {
          "active_behaviors": [],
          "on_enter": ["show_ui:game_over", "show_cursor"],
          "on_exit": ["hide_ui:game_over", "hide_cursor"],
          "transitions": [{ "when": "ui_event:game_over:play_again", "goto": "playing" }]
        }
      },
      "transitions": [{ "when": "ui_event:game_over:main_menu", "goto": "main_menu" }]
    }
  }
}
```

**02_entities.json** — Entity definitions
```json
{
  "definitions": {
    "player": {
      "mesh": { "type": "custom", "asset": "/assets/quaternius/characters/...", "scale": [0.4, 0.4, 0.4] },
      "physics": { "type": "dynamic", "mass": 75, "freeze_rotation": true, "collider": "capsule" },
      "tags": ["player"],
      "behaviors": [
        { "name": "my_movement", "script": "movement/my_movement.ts", "params": { "speed": 6 } }
      ]
    },
    "ground": {
      "mesh": { "type": "plane", "color": [0.3, 0.3, 0.3, 1], "scale": [40, 1, 40] },
      "tags": ["ground"],
      "label": false
    }
  }
}
```

**03_worlds.json** — Scene layout
```json
{
  "worlds": [{
    "id": "main",
    "name": "Main",
    "lighting": { "sun_color": [1, 0.95, 0.9] },
    "placements": [
      { "ref": "ground", "position": [0, 0, 0] },
      { "ref": "player", "position": [0, 0, 0] }
    ]
  }]
}
```

**04_systems.json** — Manager systems (global game logic)
```json
{
  "systems": {
    "scoring": { "description": "Track score", "script": "gameplay/scoring.ts" }
  }
}
```

### Custom scripts

Create scripts inside `project/`:
- `project/behaviors/{category}/{name}.ts` — per-entity behaviors
- `project/systems/{category}/{name}.ts` — standalone manager systems
- `project/ui/{name}.html` — HTML UI overlays (HUD panels, menus). In
  `01_flow.json`, reference panels **without** the `.html` extension — e.g.
  `show_ui:hud/health` (not `show_ui:hud/health.html`). The file on disk keeps
  its `.html` suffix; the action string does not.
- `project/scripts/{name}.ts` — anything else specific to this game

If a behavior or system already exists in `reference/`, prefer copying it into
`project/` over rewriting from scratch.

## Script Rules — CRITICAL

1. Use `var` instead of `let`/`const`
2. Use `function(){}` instead of `() =>` for callbacks
3. Every script extends GameScript:
```js
class MyScript extends GameScript {
    _behaviorName = "my_movement";
    _speed = 6;
    onStart() {}
    onUpdate(dt) {}
}
```
4. Params are injected by matching `_paramName` fields (prepend underscore)
5. Behaviors have `_behaviorName` — the engine auto-activates them based on FSM's `active_behaviors`

## Script API (same as FIXER_CONTEXT.md — key parts)

```js
this.entity.transform.position    // Vec3
this.scene.setPosition(id, x, y, z)
this.scene.setVelocity(id, {x, y, z})  // for dynamic bodies
this.scene.findEntityByName("Player")
this.scene.findEntitiesByTag("enemy")
this.scene.events.game.emit("entity_damaged", { entityId: 5, amount: 10 })
this.scene.events.game.on("entity_damaged", function(data) { ... })
this.scene.events.ui.emit("hud_update", { health: 75, score: 100 })
this.input.isKeyDown("KeyW")
this.input.isKeyPressed("Space")
this.input.getMouseDelta()
this.audio.playSound("/assets/kenney/audio/...", 0.5)
this.entity.playAnimation("Run", { loop: true })
```

### Reserved keys — DO NOT use for gameplay

The engine reserves these keys globally. Never bind them for game actions
(movement, firing, abilities, menu toggles, etc.):

- `KeyV` — voice chat mute toggle
- `Enter` — text chat open / send
- `KeyP` — pause menu

Pick other keys for gameplay bindings. Common free keys: `KeyE`, `KeyF`,
`KeyQ`, `KeyR`, `KeyT`, `KeyG`, `KeyC`, `KeyX`, `KeyZ`, `Tab`, digit keys.

## Transitions & FSM actions

### Transition `when` formats

A transition fires when its `when` condition matches. Supported forms:

- `ui_event:panel:action` — a button click (e.g. `ui_event:main_menu:start_game`).
  The `action` must appear as a literal `emit('action')` in `panel.html` — see
  "Button actions — validator rule" below.
- `game_event:name` — a `scene.events.game.emit("name", ...)` fired by any
  script or by an `emit:game.name` flow action. `name` must be declared in
  `project/systems/event_definitions.ts`.
- `keyboard:pause` / `keyboard:resume` — the only built-in keyboard transition
  tokens. They fire from `KeyP`. Custom key presses should be handled inside
  a behavior (check `this.input.isKeyPressed("KeyE")`) and forwarded as a
  `scene.events.game.emit("your_event", ...)`, then used as `game_event:your_event`
  in the flow.
- `mp_event:phase_in_lobby` / `mp_event:phase_in_game` /
  `mp_event:phase_browsing` / `mp_event:phase_disconnected` — session phase
  changes emitted by `mp_bridge`. These are the **only** four valid phases;
  anything else never fires.
- `net_event:<event>` — a networked event received from a peer. Broadcast
  them with the `emit:net.<event>` flow action (or `scene.events.game.emit`
  inside a script routed through `mp_bridge`). `event` should be declared
  in `event_definitions.ts` with the `net_` prefix.
- `score>=100` — variable comparison against a flow variable (set via
  `set:` / `increment:` / arithmetic actions). Operators: `>`, `<`, `>=`,
  `<=`, `==`, `!=`.
- `timer_expired` — the current state's wall-clock timer has passed its
  `duration` (seconds). Requires the state to declare a positive `duration`;
  `duration: -1` (or omitted) means never expire, so `timer_expired` never
  fires from that state.
- `random` — fire immediately with no condition. Use with an array `goto`
  to pick uniformly at random: `{ "when": "random", "goto": ["a", "b", "c"] }`.
- `random:0.3` — probabilistic per-frame fire (≈ `0.3` probability per
  second). Good for rare idle events.

### Transition-level `actions`

Any transition may include an `actions` array that runs **before** entering
the target state:

```json
{ "when": "ui_event:game_over:play_again", "goto": "playing",
  "actions": ["emit:game.restart_game", "set:score=0"] }
```

This is how restart/reset behavior is wired in the shipped templates — see
`reference/game_templates/v0.1/alien_invasion/01_flow.json`.

### Flow action verbs

Every string inside `on_enter`, `on_exit`, `on_update`, `actions`, or the
per-event `on` handlers is one of these verbs. Unknown verbs are silently
ignored — typos fail quietly.

Variables (per-flow state, survive across states):
- `set:<var>=<value>` — assign a literal, e.g. `set:score=0`. `<value>` can
  also be `$<field>` to pull from the current event payload, e.g.
  `set:last_damage=$amount` inside an `on: { entity_damaged: [...] }` handler.
- `increment:<var>` — `<var> += 1`.
- `<var>+<num>` / `<var>-<num>` — arithmetic, e.g. `score+10`, `health-5`.
  RHS can also be `$<field>`, e.g. `health-$amount`.

UI:
- `show_ui:<panel>` / `hide_ui:<panel>` — show/hide a panel from `project/ui/`.
  Use the path without `.html` (e.g. `show_ui:hud/health`).
- `show_cursor` / `hide_cursor` — toggle the virtual cursor + pointer lock.
- `notify:<text>` — fire a `show_notification` event carrying `{text}`.

Audio:
- `play_sound:<path>` — one-shot SFX (e.g. `play_sound:/assets/kenney/audio/...`).
- `play_music:<path>` — loopable music track.
- `stop_music` — stops whatever music is playing.
- `stop_sound` — stops all currently-playing SFX.

Events:
- `emit:game.<event>` — emit on the game bus. `<event>` must be declared.
- `emit:ui.<event>` — emit on the ui bus (mainly for HUD updates).
- `emit:net.<event>` — broadcast to all peers (multiplayer only). Peers
  receive it as `game_event:net_<event>`.

Multiplayer lobby shortcuts:
- `mp:show_browser` / `mp:hide_browser` — open/close the lobby browser UI.
- `mp:show_room` / `mp:hide_room` — open/close the current lobby room UI.
- `mp:refresh_lobbies` — re-poll the lobby list.
- `mp:<anything_else>` — forwarded to `mp_bridge` as `ui_event:mp:<rest>`.

Randomness:
- `random_action:a,b,c` — pick one of the comma-separated actions and run it.

### FSM structure — required fields

- The top level must have `start: "<stateName>"` pointing at the initial
  state. There is no default.
- Every compound state (one with a `substates` block) must also declare
  `start: "<substateName>"`. Without it, the substate never runs.
- Parent-state transitions can exit while a substate is active (useful for
  a global pause/quit); substate-only transitions live inside their substate.

### Silent-failure watch-list

These are NOT caught by `validate.sh` — the assembler happily ships them
and the game appears to run, but the broken piece never activates:

- **`active_behaviors` / `active_systems` name typos.** Every string in
  these arrays must exactly match a `behaviors[].name` in `02_entities.json`
  or a key in `04_systems.json`. A misspelled name (`"movemnt"` vs
  `"movement"`) is silently ignored — the behavior never turns on.
- **Unknown flow-action verbs.** Anything inside `on_enter` / `on_exit` /
  `on_update` / `actions` that doesn't match the verbs listed above is
  dropped silently. Check spelling against the list.
- **`emit:` with no dot.** `emit:game.player_died` works; bare `emit:player_died`
  is silently ignored (the parser expects `<bus>.<event>`).
- **`mp_event:` with a phase name other than the four valid ones.** The
  assembler accepts any string; only `phase_in_lobby` / `phase_in_game` /
  `phase_browsing` / `phase_disconnected` actually fire.

## Multiplayer (peer-to-peer, opt-in)

Set this block in `01_flow.json` to make the game multiplayer. Omit it for single-player games.

```json
"multiplayer": {
  "enabled": true,
  "minPlayers": 2,
  "maxPlayers": 8,         // cap 16, star topology does not scale past that
  "tickRate": 30,
  "authority": "host",     // host runs the sim, clients predict + reconcile
  "predictLocalPlayer": true,
  "hostPlaysGame": true
}
```

Mark entities that should sync across the network with a `network` block in `02_entities.json`:

```json
"player": {
  "mesh": { ... },
  "network": {
    "syncTransform": true,
    "syncInterval": 33,
    "ownership": "local_player",   // or "host" for AI/props
    "predictLocally": true,
    "networkedVars": ["health", "score"]
  },
  "behaviors": [...]
}
```

Only entities with a `network` block are transmitted; everything else is
strictly local per peer.

### Multiplayer flow actions

See the "Flow action verbs" section above (`mp:show_browser`, `emit:net.<event>`,
etc.). Peers receive a broadcast on the game bus as `net_<event>`, so the
matching transition is `net_event:<event>`.

### Reusable lobby + HUD UI panels

Pin these from `reference/ui/` — do not rewrite them:

- `ui/main_menu.html`
- `ui/lobby_browser.html`
- `ui/lobby_host_config.html`
- `ui/lobby_room.html`
- `ui/connecting_overlay.html`
- `ui/disconnected_banner.html`
- `ui/hud/ping.html` — shown only when multiplayer is enabled (auto-hides otherwise). FPS is already drawn by the play-mode shell, no separate HUD needed.
- `ui/hud/text_chat.html` — in-lobby and in-game chat (press Enter)
- `ui/hud/voice_chat.html` — mic toggle + per-peer speaking indicators
- `ui/pause_menu.html` — reusable pause overlay (see "Pause menu" below)

### Engine-owned system bridges (auto-active — do NOT list)

Two system bridges are injected + kept always-active by the assembler:

- `systems/ui/ui_bridge.ts` — every game (HUD, menu, cursor, notifications).
- `systems/mp/mp_bridge.ts` — any game with a `"multiplayer"` block in
  `01_flow.json` (even if `enabled` is unset).

Do **NOT** list either of these in any state's `active_systems`. Listing
them is redundant (the assembler already activated them) and just wastes
JSON. `active_systems` is for your own game-logic systems from
`04_systems.json` (scoring, wave spawners, enemy AI, etc.).

### Typical multiplayer flow skeleton

```
boot → main_menu → lobby_browser ⇄ lobby_host_config → lobby_room → gameplay → game_over
                                                          ↑                        ↓
                                                          └── (play again) ────────┘
```

Transitions to watch for:
- `mp_event:phase_in_lobby` → you've entered a room (via create or join)
- `mp_event:phase_in_game`  → host pressed Start; match is live
- `mp_event:phase_browsing` → back to the lobby list
- `mp_event:phase_disconnected` → socket/session dropped; fall back to main_menu

See `reference/game_templates/v0.1/multiplayer_arena/` for a complete example.

## Pause menu (optional, reusable)

Pin `ui/pause_menu.html` and wire it via the FSM. Buttons are fully
configurable through `ui_params.pause_menu.pauseButtons` — each button's
`action` becomes the tail of a `ui_event:pause_menu:<action>` transition.

```json
"ui_params": {
  "pause_menu": {
    "pauseTitle": "PAUSED",
    "pauseSubtitle": "",
    "pauseHint": "Press <span class=\"pm-kbd\">P</span> to resume",
    "pauseButtons": [
      { "action": "resume", "label": "Resume", "primary": true },
      { "action": "retry",  "label": "Retry" },
      { "action": "leave_match", "label": "Leave Match", "danger": true },
      { "action": "main_menu",    "label": "Main Menu" }
    ]
  }
}
```

Typical FSM wiring — a `paused` substate under `gameplay`:

```json
"gameplay": {
  "start": "playing",
  "substates": {
    "playing": {
      "active_behaviors": ["movement", "combat"],
      "transitions": [
        { "when": "keyboard:pause", "goto": "paused" }
      ]
    },
    "paused": {
      "active_behaviors": [],
      "on_enter": ["show_ui:pause_menu", "show_cursor"],
      "on_exit":  ["hide_ui:pause_menu", "hide_cursor"],
      "transitions": [
        { "when": "keyboard:resume",            "goto": "playing" },
        { "when": "ui_event:pause_menu:resume", "goto": "playing" },
        { "when": "ui_event:pause_menu:retry",  "goto": "playing" }
      ]
    }
  },
  "transitions": [
    { "when": "ui_event:pause_menu:main_menu",   "goto": "main_menu" },
    { "when": "ui_event:pause_menu:leave_match", "goto": "main_menu" }
  ]
}
```

Notes:
- `keyboard:pause` fires on `KeyP` only. Don't bind `Escape` — the browser
  owns it for exiting pointer lock.
- Omit `pauseButtons` to get the default (`Resume` + `Main Menu`).
- Only include buttons that make sense for the game — no button appears
  unless you list it. Single-player shouldn't include `leave_match`;
  multiplayer typically replaces `retry` with `leave_match`.
- `ui_event:pause_menu:<action>` transitions in the `paused` substate
  should go back to `playing`; transitions that exit the match should be
  on the parent `gameplay` state.

## Physics Rules
- `dynamic` + `setVelocity()` for moving characters (NOT `setPosition`)
- `kinematic` + `setPosition()` for scripted movers (enemies, platforms)
- `static` for walls, ground
- `freeze_rotation: true` for all characters

### Collider shape

Default: every entity gets a unit box collider unless you override. The
override goes on `physics.collider`:

- **String form** — uses sensible defaults. `"collider": "capsule"` (humanoids),
  `"collider": "sphere"`, `"collider": "box"`, `"collider": "mesh"` (exact
  hull from the GLB — slow, only for static world geometry).
- **Object form** — custom dimensions:
  ```json
  "physics": {
    "type": "static",
    "collider": { "shape": "cuboid", "halfExtents": [5, 1, 20] }
  }
  ```
  Supported shapes in object form: `cuboid` (uses `halfExtents`), `sphere`
  (uses `radius`), `capsule` (uses `radius` + `height`). See
  `reference/game_templates/v0.1/multiplayer_coin_grab/02_entities.json` and
  `banner_siege/02_entities.json` for real usage.
- **Trigger zones** — add `"is_trigger": true` inside the `physics` block
  to turn the collider into a non-blocking trigger. Scripts see
  `onTriggerEnter(otherId) / onTriggerStay / onTriggerExit`. Used for pickups,
  goal lines, damage volumes.

## UI Panels
HTML files in `project/ui/` receive game state via postMessage. Example HUD:
```html
<div id="hp" style="position:fixed;bottom:20px;left:20px;color:white;">100</div>
<script>
function update(state) {
  if (state.health !== undefined) document.getElementById('hp').textContent = Math.round(state.health);
}
window.addEventListener('message', function(e) { if (e.data && e.data.type === 'gameState') update(e.data.state); });
</script>
```

Scripts push state via: `this.scene.events.ui.emit("hud_update", { health: 75 })`

### Button actions — validator rule

Buttons emit commands via `window.parent.postMessage`, but the assembler's static validator only recognizes a button if a matching `emit('literal_action')` call appears somewhere in the panel's `<script>`. It does NOT scan `postMessage(...)` calls or dynamic `emit(variable)` calls.

Required pattern — define an `emit()` wrapper and call it with a **string literal** for each distinct action:

```html
<script>
function emit(action) {
  window.parent.postMessage({ type: 'game_command', action: action, panel: 'main_menu' }, '*');
}
document.getElementById('start-btn').onclick = function() { emit('start_game'); };
document.getElementById('settings-btn').onclick = function() { emit('open_settings'); };
</script>
```

Here `emit('start_game')` and `emit('open_settings')` are visible to the validator — it will count 2 buttons on this panel.

**Dynamic card / pool UIs** (e.g. a level-up screen that picks 3 of 6 upgrades at runtime). The *rendered* buttons may be dynamic, but every possible action name MUST still appear as `emit('literal')` somewhere in the script so the validator can see them. Typical shape:

```html
<script>
function emit(action) {
  window.parent.postMessage({ type: 'game_command', action: action, panel: 'level_up' }, '*');
}
// Declare ALL possible actions as literal calls the validator can see.
// These are unreachable at runtime but serve as a static manifest:
// eslint-disable-next-line no-unused-expressions
function __validatorManifest() {
  emit('damage_up'); emit('attack_speed'); emit('range_up');
  emit('move_speed'); emit('max_health'); emit('multi_hit');
}
// Actual runtime rendering can still be fully dynamic:
function renderChoices(choices) {
  for (var i = 0; i < choices.length; i++) {
    (function(choice) {
      var card = document.createElement('div');
      card.textContent = choice.label;
      card.onclick = function() { emit(choice.type); };  // variable — invisible to the validator
      document.getElementById('cards').appendChild(card);
    })(choices[i]);
  }
}
</script>
```

The `__validatorManifest` stub is never called at runtime but ensures every action name is present as `emit('literal')` for the assembler's static check. Without it, the validator reports **"no buttons found in <panel>.html"** even though the UI works fine in the browser.

Every `ui_event:panel:action` transition in `01_flow.json` must correspond to an `emit('action')` literal call in that panel's HTML — 1:1. Actions declared in the manifest but never used by the FSM are harmless; FSM transitions with no matching literal are a hard failure.

## Available Assets
Read files in the `assets/` directory:
- `assets/3D_MODELS.md` — all 3D model packs with paths
- `assets/AUDIO.md` — all audio files with paths
- `assets/TEXTURES.md` — all texture files with paths

## Event Definitions
Read `project/systems/event_definitions.ts` (the project's pinned copy — there is also `reference/systems/event_definitions.ts` if needed).

**Default to the existing events** when a reasonable one already covers what you need — it keeps your game compatible with future engine features. Prefer:
- `entity_killed` over a new `enemy_killed`
- `wave_started` over a new `wave_cleared` / `wave_complete`
- `entity_damaged` over a new `enemy_damaged`
- `entity_destroyed` over a new `enemy_reached_base`

**But you MAY extend `project/systems/event_definitions.ts`** with game-specific events when the mechanic genuinely needs them (e.g. `tornado_spawned` for a disaster game, `quest_accepted` for an RPG, `combo_broken` for a fighting game). Rules when adding:
1. Match the existing format exactly — `event_name: { fields: { fieldA: { type: 'number' }, fieldB: { type: 'string', optional: true } } }`.
2. Supported field types: `number`, `string`, `boolean`, `object`, `any`.
3. **Do NOT rename or remove any existing event** — other engine code and reference behaviors rely on them; renames break projects silently.
4. Keep new event names lowercase snake_case and scoped to your game (`rocket_launched`, not `event1` or `myEvent`).

Any script that emits/listens for an event NOT in `project/systems/event_definitions.ts` after your run will fail validation. The full baseline list is in TASK.md + `reference/event_definitions.ts`.

## Reference Templates
Look at `reference/game_templates/` for working examples of complete templates.

## Validation
After creating all files, run `bash validate.sh`. Fix any errors before finishing.

## Quality Checklist
- [ ] Flow has boot → main_menu → gameplay → game_over path
- [ ] Player entity with movement behavior
- [ ] Camera entity with camera behavior
- [ ] At least one gameplay mechanic (enemies, objectives, etc.)
- [ ] HUD shows relevant info (health, score, timer, etc.)
- [ ] Game over condition exists
- [ ] All behavior scripts referenced in 02_entities.json exist in project/behaviors/
- [ ] All system scripts referenced in 04_systems.json exist in project/systems/
- [ ] All UI panels referenced in 01_flow.json exist in project/ui/
- [ ] validate.sh passes
