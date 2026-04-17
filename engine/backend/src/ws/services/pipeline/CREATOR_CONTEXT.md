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
  systems/ui/ui_bridge.ts          — UI bridge (already pinned)
  systems/mp/mp_bridge.ts          — Multiplayer session bridge (pinned; activate when multiplayer is enabled)
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

## Transition Formats
- `ui_event:panel:action` — UI button (e.g., `ui_event:main_menu:start_game`)
- `game_event:name` — game event (e.g., `game_event:player_died`)
- `keyboard:action` — key press (e.g., `keyboard:pause`)
- `mp_event:phase_in_game` — multiplayer session phase change
- `net_event:match_ended` — networked game event received from a peer
- `score>=100` — variable comparison
- `timer_expired` — state duration elapsed

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

### Multiplayer flow actions (FSM shortcuts)

- `mp:show_browser` / `mp:show_room` — open the lobby browser / lobby room UI
- `mp:hide_browser` / `mp:hide_room`
- `mp:refresh_lobbies` — request the current lobby list
- `emit:net.<event>` — broadcast a networked event to all peers
  (arrives on peers as `net_<event>` on the game bus; transition with `net_event:<event>`)

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

### Required pinned system

Every multiplayer game needs `systems/mp/mp_bridge.ts` active (list it in
`active_systems` for every state). Without it, the lobby/HUD UIs won't receive
state and the session won't drive phase transitions.

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
- `"collider": "capsule"` for humanoids, box for everything else

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

Buttons emit commands: `window.parent.postMessage({ type: 'game_command', action: 'start_game', panel: 'main_menu' }, '*')`

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
