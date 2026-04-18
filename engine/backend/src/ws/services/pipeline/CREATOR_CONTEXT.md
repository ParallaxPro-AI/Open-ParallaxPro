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
      "mesh": { "type": "custom", "asset": "/assets/quaternius/characters/...", "scale": [0.4, 0.4, 0.4], "modelRotationY": 180 },
      "mesh_override": { "textureBundle": "/assets/kenney/textures/prototype_textures/Dark/texture_02.png" },
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

### Mesh options

`mesh.type`: `custom` (GLB/GLTF from `asset`), `plane`, `cube`, `sphere`, `cylinder`, `cone`, `capsule`, `empty` (no geometry).

For `custom` meshes:
- `asset`: path from the asset catalog (see `assets/3D_MODELS.md`).
- `scale`: `[x, y, z]` — uniform usually.
- `modelRotationY` / `modelRotationX` / `modelRotationZ`: bake a rotation into the loaded mesh (**degrees**). Use `modelRotationY: 180` when the asset's "forward" faces the wrong way (common for Quaternius character packs).

For primitive meshes:
- `color`: `[r, g, b, a]` 0–1. Applied to the mesh's default material.
- `scale`: same as above.

### Material overrides

`mesh_override` on the def merges with `material_overrides` on the placement; placement wins. Currently supports:
- `textureBundle`: path to a prototype-grid or tileable texture asset.

### Labels

Every non-camera, non-manager, non-custom-mesh entity gets a floating name label above it for debug/editor visibility. Set `"label": false` to suppress (common on ground/walls/decorations to reduce clutter). Cameras and `manager` / `managers_root`-tagged entities are auto-suppressed.

**03_worlds.json** — Scene layout
```json
{
  "worlds": [{
    "id": "main",
    "name": "Main",
    "environment": {
      "ambientColor": [0.52, 0.58, 0.72],
      "ambientIntensity": 0.55,
      "sunColor": [1.0, 0.92, 0.78],
      "sunIntensity": 1.0,
      "fog": { "enabled": true, "color": [0.65, 0.68, 0.78], "near": 35, "far": 110 },
      "gravity": [0, -9.81, 0]
    },
    "placements": [
      { "ref": "ground", "position": [0, 0, 0] },
      { "name": "Player", "ref": "player", "position": [0, 1, 0] },
      { "ref": "camera", "position": [0, 6, 10] },
      { "ref": "castle_wall", "position": [-30, 2.2, -5], "rotation": [0, 90, 0] }
    ]
  }]
}
```

### Lighting / `environment` block

Preferred (newer, camelCase) keys:
- `ambientColor: [r, g, b]` and `ambientIntensity: number` — global fill.
- `sunColor: [r, g, b]` and `sunIntensity: number` — directional key light.
- `fog: { enabled: bool, color: [r,g,b], near: number, far: number }` — distance fog.
- `gravity: [x, y, z]` — physics gravity vector, e.g. `[0, -9.81, 0]`.

Legacy keys (also recognized, snake_case): `lighting.sun_color`, `lighting.ambient`. Either works; `environment` is preferred.

### Placement fields

- `ref` (required) — entity def key in `02_entities.json`.
- `position` — `[x, y, z]`.
- `rotation` — `[x, y, z]` euler degrees OR `[x, y, z, w]` quaternion.
- `scale` — `[x, y, z]`; overrides `mesh.scale` on the def.
- **`name`** — entity instance name. This is what `scene.findEntityByName("Player")` looks up at runtime. Give your player, camera, and any script-targeted entities explicit names. If omitted, auto-generated (often `Player (1)` etc. — unreliable for lookup).
- `tags` — additional tags merged onto the def's tags.
- `material_overrides` — same shape as `mesh_override` on the def; placement wins on conflict.
- `active` — `false` to spawn inactive.

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

## Script API

### Lifecycle

Every script extends `GameScript`. Available hooks (all optional):
- `onStart()` — once when the behavior/system becomes active.
- `onUpdate(dt)` — every rendered frame.
- `onLateUpdate(dt)` — every frame after all `onUpdate`s (cameras, UI follow logic).
- `onFixedUpdate(fixedDt)` — fixed-timestep tick for physics-sensitive work.
- `onDestroy()` — once when the entity or behavior is removed.
- `onCollisionEnter(otherId)` / `onCollisionStay(otherId)` / `onCollisionExit(otherId)` — solid-body contacts.
- `onTriggerEnter(otherId)` / `onTriggerStay(otherId)` / `onTriggerExit(otherId)` — fire only on colliders marked `is_trigger: true`.

### System vs behavior activation — timing gotcha

Behaviors and systems activate differently, and it matters for event wiring:

- **Behaviors** live on entities that are active at scene load. Their `onStart`
  runs up front, before any FSM transition. The FSM later flips a per-behavior
  `_behaviorActive` flag via the `active_behaviors` event — but the `on(...)`
  listeners inside `onStart` are already registered by then.
- **Systems** live on entities that start `active=false` (except the two auto-
  active bridges, `ui` and `mp_bridge`). Their `onStart` only runs *after*
  the FSM enters a state whose `active_systems` includes them.

The trap: if an FSM state's `on_enter` emits an event *and* that same state
(or its substate) is what activates the system, the system's `onStart`
hasn't run yet — its `on(...)` listener isn't registered, and the emit
is lost. Events are fire-and-forget; they don't queue. Real-world failure
mode: a `game_ready` / `match_start` event emitted from `gameplay.on_enter`
never triggers the system's `_resetGame()`, so `_gameActive` stays false,
`onUpdate` early-returns forever, and the HUD reads `0 score, wave 1, 0:00`
while the player walks around an empty arena.

**Rule**: a system's first-time initialization must live **in `onStart`
itself**, not in an `on("some_event", ...)` that fires from the state that
activates it. Use events only for things that happen *after* the system is
already running (like `restart_game` triggered from a game-over button).

Correct shape for a gameplay system:

```js
class MyGameSystem extends GameScript {
    _active = false;
    onStart() {
        var self = this;
        this._startMatch();                                   // first-time init
        this.scene.events.game.on("restart_game", function() { self._startMatch(); });
    }
    _startMatch() {
        this._active = true;
        // reset counters, clear spawned entities, etc.
    }
    onUpdate(dt) {
        if (!this._active) return;
        // wave spawning, timers, …
    }
}
```

### `this.entity` (own entity)

```js
this.entity.id                             // number
this.entity.name                           // string
this.entity.active                         // boolean
this.entity.setActive(false)               // toggle
this.entity.transform.position             // { x, y, z }
this.entity.transform.rotation             // { x, y, z, w } quaternion
this.entity.transform.scale                // { x, y, z }
this.entity.transform.lookAt(x, y, z)
this.entity.transform.setRotationEuler(x, y, z)  // degrees
this.entity.getComponent("RigidbodyComponent")
this.entity.playAnimation("Run", { loop: true })
this.entity.setMaterialColor(r, g, b, a)
this.entity.addTag("foo") / removeTag("foo")
this.entity.getScript("SiblingClassName")  // fetch a sibling script instance
```

### `this.scene`

Entity lookup + lifecycle:
```js
this.scene.findEntityByName("Player")          // single match or null
this.scene.findEntitiesByTag("enemy")          // array
this.scene.getAllEntities()                    // [{ id, name }]
this.scene.createEntity("TempMarker")          // returns id
this.scene.spawnEntity("bullet")               // instantiate prefab by def name
this.scene.destroyEntity(id)
```

Transform (for OTHER entities by id):
```js
this.scene.setPosition(id, x, y, z)
this.scene.setScale(id, x, y, z)
this.scene.setRotationEuler(id, x, y, z)       // degrees
this.scene.setVelocity(id, { x, y, z })        // dynamic bodies only
```

Queries:
```js
this.scene.raycast(ox, oy, oz, dx, dy, dz, maxDist)   // world ray
this.scene.screenRaycast(screenX, screenY)            // from camera through pixel
this.scene.screenPointToGround(screenX, screenY, 0)   // project onto Y-plane
this.scene.getTerrainHeight(x, z)
```

Environment:
```js
this.scene.setFog(enabled, color, near, far)
this.scene.setTimeOfDay(hour)                  // 0–24
this.scene.loadScene("other_scene")
```

Persistence:
```js
this.scene.saveData("highscore", 42)
this.scene.loadData("highscore")
```

### Events

Two buses. `game` is for gameplay events (validated against `event_definitions.ts`). `ui` is for HUD/menu state push (no validation).

```js
this.scene.events.game.emit("entity_damaged", { entityId: 5, amount: 10 })
this.scene.events.game.on("entity_damaged", function(data) { ... })
this.scene.events.ui.emit("hud_update", { health: 75, score: 100 })
```

### `this.input`

These are the only methods on the real InputSystem. There are NO `getKey`,
`getKeyDown`, `getKeyUp`, `getMouseButton`, or `getMouseScroll` methods — they
do not exist at runtime, calling them throws TypeError, and the throw kills
the rest of `onUpdate`.

```js
// Keyboard (use KeyboardEvent.code values: "KeyW", "Space", "ArrowUp", ...)
this.input.isKeyDown("KeyW")           // held this frame
this.input.isKeyPressed("Space")       // first frame the key went down
this.input.isKeyReleased("KeyE")       // first frame the key came up

// Mouse buttons (number: 0=left, 1=middle, 2=right; OR strings "MouseLeft" / "MouseMiddle" / "MouseRight")
this.input.isMouseButtonDown(0)
this.input.isMouseButtonJustPressed(0)
this.input.isMouseButtonJustReleased(0)

// Mouse position / movement / scroll
this.input.getMousePosition()          // { x, y } in screen pixels
this.input.getMouseDelta()             // { x, y } since last frame
this.input.getScrollDelta()            // { x, y } wheel delta this frame

// Pointer lock (FPS / mouse-look games)
this.input.requestPointerLock()
this.input.exitPointerLock()
this.input.isPointerLocked()
```

### `this.audio`

```js
this.audio.playSound("/assets/.../laser.ogg")
this.audio.playMusic("/assets/.../music.ogg")
this.audio.stopMusic()
```

### `this.ui`

```js
var t = this.ui.createText({ text: "Hello", x: 20, y: 20, color: "#fff" })
t.text = "Updated"
t.remove()
```

Most games should drive UI via HTML panels + `events.ui.emit("hud_update", …)` instead of `this.ui.createText`. Use `createText` / `createButton` only for quick, code-only overlays.

### `this.time`

```js
this.time.time          // seconds since scene start
this.time.deltaTime     // last frame delta (seconds)
this.time.frameCount
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
- **Systems that init from an `on_enter` event fire BEFORE the system is
  listening.** See "System vs behavior activation" above. Result: the
  system's gameplay loop never starts and the HUD stays at defaults.
  Always do first-time init directly in `onStart`.
- **`spawnEntity(variable)` with names not declared as literals anywhere.**
  The static validator only sees `spawnEntity('literal')` calls. Dynamic
  pools must declare every possible name in a `__validatorManifest()` stub
  (parallel to the button-action rule). See "Spawn entity — validator rule".

## Multiplayer (peer-to-peer, opt-in)

Set this block in `01_flow.json` to make the game multiplayer. Omit it for single-player games.

```json
"multiplayer": {
  "enabled": true,
  "minPlayers": 2,
  "maxPlayers": 8,              // cap 16, star topology does not scale past that
  "tickRate": 30,
  "authority": "host",          // host runs the sim, clients predict + reconcile
  "predictLocalPlayer": true,
  "hostPlaysGame": true,
  "remotePlayerPrefab": "player" // prefab name from 02_entities.json auto-spawned for remote peers; set to null to opt out and spawn them yourself
}
```

**`remotePlayerPrefab`** is important: when a peer joins, the engine auto-spawns an entity using the prefab name you give here. Usually set to `"player"` (the same prefab the local player uses). Set to `null` if your game needs to spawn remote proxies manually from a gameplay system. Omitting the field entirely falls back to a default blue capsule — don't rely on that; set it explicitly.

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

Scripts push state via: `this.scene.events.ui.emit("hud_update", { health: 75, maxHealth: 100, score: 42 })`

The `state` object is merged — every emit adds/updates keys; nothing clears them. Each panel's `update(state)` should tolerate missing keys (use `if (state.foo !== undefined)` guards).

### State keys the reusable HUDs expect

When you pin a reusable HUD from `reference/ui/hud/`, your game system must emit the keys that panel reads. Mismatched/missing keys = blank display.

| Panel | Required state keys |
| --- | --- |
| `hud/health.html` | `health`, `maxHealth` |
| `hud/ability_bar.html` | `health`, `maxHealth`, `mana`, `maxMana`, `qCooldown`, `qMaxCooldown`, `eCooldown`, `eMaxCooldown`, `spaceCooldown`, `spaceMaxCooldown`, `heroDead` |
| `hud/ping.html` | `multiplayer.enabled`, `multiplayer.ping`, `multiplayer.connected` |
| `hud/scoreboard.html` | `scoreboard.players` (array of `{ username, score, isLocal }`), `scoreboard.scoreLabel`, `scoreboard.scoreToWin` |
| `hud/text_chat.html` | `username`, `multiplayer.chatHistory` (array of `{ fromUsername, body }`), `multiplayer.openChat` |
| `hud/voice_chat.html` | `multiplayer.micOn`, `multiplayer.muted`, `multiplayer.voicePeers` (array of `{ username, level }`) |

If you're writing a **custom** HUD, you get to pick your own key names — just stay consistent between your emitter and your panel.

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

### Spawn entity — validator rule

`scene.spawnEntity(name)` instantiates a prefab from `02_entities.json` `definitions` by its key. The assembler statically scans every script for `spawnEntity('literal')` calls and rejects any name that isn't a declared key — same shape as the `emit('literal')` rule above. The runtime engine also throws on unknown names, so a typo here is a hard failure either way.

Required pattern — pass a **string literal** matching a definition key:

```js
// 02_entities.json declares "enemy_slime", "enemy_bat", "xp_gem"
this.scene.spawnEntity("enemy_slime");   // visible to validator — OK
this.scene.spawnEntity("xp_gem");        // visible to validator — OK
```

**Dynamic spawn pools** (e.g. a wave spawner that picks 1 of N enemy types at runtime). The *call* may pass a variable, but every possible name MUST appear as a literal somewhere in the script so the validator can see it. Same `__validatorManifest` shape as the button rule:

```ts
class WaveSpawnerSystem extends GameScript {
    _enemyTypes = ["enemy_slime", "enemy_skeleton", "enemy_bat"];

    onUpdate(dt) {
        var type = this._enemyTypes[Math.floor(Math.random() * this._enemyTypes.length)];
        this.scene.spawnEntity(type);  // variable — invisible to the validator
    }

    // Static manifest so the validator sees every possible name. Never
    // called at runtime — just a parse-visible declaration.
    __validatorManifest() {
        this.scene.spawnEntity("enemy_slime");
        this.scene.spawnEntity("enemy_skeleton");
        this.scene.spawnEntity("enemy_bat");
    }
}
```

Without the manifest, the validator can't see the dynamic names — but the runtime still throws if any of them turn out to be unknown. The manifest moves that catch from "first wave at runtime in the browser" to "validate.sh fails before the CLI ships."

For genuinely blank entities (rare — usually you want a prefab), use `scene.createEntity(name)` instead. That's the bare-create path and isn't validated.

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

## Sharing state across behaviors (`scene._*` convention)

Behaviors that need to exchange runtime data with no formal API attach properties
directly to the `scene` object, prefixed with underscore:

```js
// Camera writes its yaw every frame
this.scene._tpYaw = newYaw;

// Grab-arms behavior reads it to align the grab direction
var yaw = this.scene._tpYaw || 0;
```

This is a convention, not a formal contract — the engine doesn't enforce types
or ordering. Treat them as hints, not authoritative state. Examples in the
library: `scene._fpsYaw` (fps_combat ↔ block_interact), `scene._tpYaw`
(camera_platformer ↔ grab_arms), `scene._heroDead` (hero_combat ↔ ability_bar
HUD), `scene._riftMouseAim` (MOBA cursor `{ x, z }`). Use when two cooperating
scripts need to share per-frame context without growing a plumbing layer.

## Validation
After creating all files, run `bash validate.sh`. Fix any errors before finishing.

The assembler's checks are strict — see the "Silent-failure watch-list" above
for what it now rejects (typos in `active_behaviors`/`active_systems`, missing
`start`, button-wiring gaps).

## Quality Checklist

**Validator-enforced** — `validate.sh` will fail if any of these is missing:
- [ ] All four template JSONs parse and are well-formed.
- [ ] Every behavior script referenced in `02_entities.json` exists in `project/behaviors/` (or was copied from `reference/`).
- [ ] Every system script referenced in `04_systems.json` exists in `project/systems/`.
- [ ] Every `show_ui:<panel>` action points at a file that exists in `project/ui/`.
- [ ] Every `active_behaviors` entry matches a behavior `name` declared in `02_entities.json`.
- [ ] Every `active_systems` entry matches a key in `04_systems.json` (or is `ui`/`mp_bridge`).
- [ ] Every `ui_event:panel:action` transition matches an `emit('action')` literal in that panel's HTML.
- [ ] Every `game_event:<name>` matches an event declared in `project/systems/event_definitions.ts`.
- [ ] The root flow has `start`, and every compound state has its own `start`.

**Aspirational (good games have these, but validator won't fail without them):**
- [ ] Flow has boot → main_menu → gameplay → game_over.
- [ ] Player entity with movement behavior.
- [ ] Camera entity with camera behavior.
- [ ] At least one gameplay mechanic (enemies, objectives, etc.).
- [ ] HUD shows relevant info (health, score, timer, etc.).
- [ ] Game-over condition exists.
