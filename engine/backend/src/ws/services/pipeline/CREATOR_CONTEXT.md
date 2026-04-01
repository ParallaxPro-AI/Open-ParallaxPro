# ParallaxPro Game Engine — Template Creator Context

You are creating a NEW game template from scratch for the ParallaxPro 3D game engine. The user described a game they want, and you need to create all the files for it.

## SECURITY CONSTRAINTS — MANDATORY
- You may ONLY create/edit files under `template/` and `new_scripts/`
- You may read (NOT edit) files under `reference/` and `assets/`
- You may NOT access files outside the sandbox

## What You Must Create

### In `template/` — 4 JSON files:

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

### In `new_scripts/` — Custom scripts

Create behavior and system scripts here:
- `new_scripts/behaviors/{category}/{name}.ts` — per-entity behaviors
- `new_scripts/systems/{category}/{name}.ts` — standalone manager systems
- `new_scripts/ui/{name}.html` — HTML UI overlays (HUD panels, menus)

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

## Transition Formats
- `ui_event:panel:action` — UI button (e.g., `ui_event:main_menu:start_game`)
- `game_event:name` — game event (e.g., `game_event:player_died`)
- `keyboard:action` — key press (e.g., `keyboard:pause`)
- `score>=100` — variable comparison
- `timer_expired` — state duration elapsed

## Physics Rules
- `dynamic` + `setVelocity()` for moving characters (NOT `setPosition`)
- `kinematic` + `setPosition()` for scripted movers (enemies, platforms)
- `static` for walls, ground
- `freeze_rotation: true` for all characters
- `"collider": "capsule"` for humanoids, box for everything else

## UI Panels
HTML files in `new_scripts/ui/` receive game state via postMessage. Example HUD:
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

## Event Definitions — STRICT
Read `reference/event_definitions.ts` for all valid game event names and their payloads.

**CRITICAL**: You MUST ONLY use event names that exist in event_definitions.ts. The assembler will REJECT any scripts that use unknown events. Do NOT invent new event names like "enemy_killed" or "wave_cleared" — use the existing ones:
- Use `entity_killed` (not `enemy_killed`)
- Use `wave_started` (not `wave_cleared` or `wave_complete`)
- Use `entity_damaged` (not `enemy_damaged`)
- Use `entity_destroyed` (not `enemy_reached_base`)

The full list is in TASK.md and in `reference/event_definitions.ts`.

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
- [ ] All behavior scripts referenced in 02_entities.json exist in new_scripts/
- [ ] All system scripts referenced in 04_systems.json exist in new_scripts/
- [ ] All UI panels referenced in 01_flow.json exist in new_scripts/ui/
- [ ] validate.sh passes
