# PHASE 3 — SYSTEMS + FLOW

Your only job: fill `project/04_systems.json` and `project/01_flow.json`. Phases 1 and 2 ran before you — consult their outputs.

## Steps

1. `cat handoff/spec.json` — the plan.
2. Read `project/02_entities.json` and `project/03_worlds.json` — so your active_behaviors / placements line up.
3. `bash library.sh show templates/<template>` — reference the same template Phase 1 picked.
4. Fetch library systems via `bash library.sh show <path>` (or `list systems` first if unsure what exists).
5. Write `project/04_systems.json` and `project/01_flow.json`.
6. Write `handoff/phase3_complete` and exit.

## 04_systems.json

```json
{
  "systems": {
    "scoring": {
      "description": "Track score, emit match_end on limit",
      "script": "gameplay/scoring.ts",
      "params": { "winScore": 20 }
    }
  }
}
```

System scripts are referenced from `01_flow.json`'s `active_systems` arrays by KEY (e.g. `"scoring"`), not file path. Pinned bridges `ui_bridge` and `mp_bridge` are auto-active — **do NOT list** them in `active_systems`.

## 01_flow.json

Hierarchical FSM. States have `active_systems`, `active_behaviors`, `on_enter`/`on_exit`/`on_update` action lists, and `transitions`.

```json
{
  "id": "my_game_flow",
  "name": "My Game",
  "start": "boot",
  "ui_params": {
    "main_menu": { "gameTitle": "MY GAME", "gameSubtitle": "subtitle" }
  },
  "states": {
    "boot": {
      "duration": -1,
      "on_enter": ["set:boot_frames=0"],
      "on_update": ["increment:boot_frames"],
      "transitions": [ { "when": "boot_frames>=2", "goto": "main_menu" } ]
    },
    "main_menu": {
      "on_enter": ["show_ui:main_menu", "show_cursor"],
      "on_exit":  ["hide_ui:main_menu", "hide_cursor"],
      "transitions": [ { "when": "ui_event:main_menu:play", "goto": "gameplay" } ]
    },
    "gameplay": {
      "active_systems": ["scoring"],
      "active_behaviors": ["player_movement", "follow_camera"],
      "states": {
        "playing": {
          "transitions": [
            { "when": "keyboard:pause",          "goto": "paused" },
            { "when": "game_event:match_end",    "goto": "@gameplay:game_over" }
          ]
        },
        "paused": {
          "on_enter": ["show_ui:pause_menu", "show_cursor", "pause_physics"],
          "on_exit":  ["hide_ui:pause_menu", "hide_cursor", "resume_physics"],
          "transitions": [
            { "when": "keyboard:resume",                          "goto": "playing" },
            { "when": "ui_event:pause_menu:resume",               "goto": "playing" },
            { "when": "ui_event:pause_menu:main_menu",            "goto": "@main_menu" }
          ]
        }
      },
      "start": "playing"
    },
    "game_over": {
      "on_enter": ["show_ui:game_over"],
      "on_exit":  ["hide_ui:game_over"],
      "transitions": [
        { "when": "ui_event:game_over:play_again", "goto": "gameplay",
          "actions": ["emit:game.restart_game", "set:score=0"] },
        { "when": "ui_event:game_over:main_menu", "goto": "main_menu" }
      ]
    }
  }
}
```

### Transition `when` formats

| Format | Fires when |
|---|---|
| `"boot_frames>=2"` | FSM var (from `set:`) meets condition |
| `"ui_event:<panel>:<action>"` | button in `<panel>.html` emits `<action>` |
| `"game_event:<name>"` | any script does `this.scene.events.game.emit("<name>", ...)` |
| `"keyboard:<key>"` | input fires — built-ins: `pause`, `resume`, `jump`, etc. Use `keyboard:KeyP` style for others. |
| `"mp_event:<phase>"` | multiplayer phase change (MP only) |
| `"net_event:<name>"` | network event (MP only) |

`goto` takes a sibling state name OR `@parent:child` for hierarchical jumps.

### Transition-level `actions`
Any transition may include `actions` that run BEFORE entering the target:
```json
{ "when": "ui_event:game_over:play_again", "goto": "playing",
  "actions": ["emit:game.restart_game", "set:score=0"] }
```

### Flow action verbs

Strings in `on_enter`, `on_exit`, `on_update`, `actions`, or per-event `on` handlers. Unknown verbs are silently ignored — typos fail quietly, so check your spelling.

Categories:
- **UI**: `show_ui:<panel>`, `hide_ui:<panel>`, `show_cursor`, `hide_cursor`, `show_ui:hud/<name>` (slashed path for sub-panels)
- **Physics**: `pause_physics`, `resume_physics`
- **Events**: `emit:game.<event>` (emits a game event with no payload; for payload use a script), `emit:net.<event>` (MP)
- **FSM vars**: `set:var=value`, `increment:var`, `decrement:var`, `reset:var`
- **Multiplayer**: `mp:show_browser`, `mp:show_host_config`, `mp:join_lobby`, `mp:leave_lobby`, `mp:start_match`, `mp:end_match`
- **Scene**: `pause_all_scripts`, `resume_all_scripts`

### FSM structure — required fields
- Every state or substate needs either leaf-style (no nested `states`) OR branch-style (with nested `states` + `start`).
- Top-level `"start"` is required.
- `transitions` must reference states that exist (validator catches typos).

### Silent-failure watch-list

These fail the assembler without clear errors:
- Any entry in `active_behaviors` that isn't in `02_entities.json` → ignored silently; behavior never activates
- Any entry in `active_systems` that isn't in `04_systems.json` (or is the auto-active `ui_bridge`/`mp_bridge` — don't list them) → silent no-op
- Any `show_ui:<panel>` where `<panel>.html` doesn't exist in `project/ui/` → UI never renders
- `on_enter` that emits an event that's also the state's own activation → event lost (system's `onStart` hasn't run yet); put first-time init in `onStart`, not in an event from the activating state
- `ui_event:<panel>:<action>` where the panel HTML doesn't `emit('<action>')` → transition never fires; silent

## Multiplayer (if `spec.is_multiplayer`)

Add a top-level `multiplayer` block:
```json
"multiplayer": {
  "enabled": true,
  "max_players": 4,
  "tick_rate": 30
}
```

Wire an FSM skeleton: `boot → main_menu → lobby_browser ⇄ lobby_host_config → lobby_room → gameplay → game_over`.

Flow actions you'll use: `mp:show_browser`, `mp:show_host_config`, `mp:create_lobby`, `mp:join_lobby`, `mp:leave_lobby`, `mp:start_match`.

Reusable UI panels to pin (fetch via `library.sh show ui/<name>.html`):
- `lobby_browser.html`, `lobby_host_config.html`, `lobby_room.html`, `connecting_overlay.html`, `disconnected_banner.html`
- `hud/ping.html`, `hud/text_chat.html`, `hud/voice_chat.html`, `hud/scoreboard.html`

Transitions to watch for:
- `mp_event:phase_in_lobby` → entered a room
- `mp_event:phase_in_game` → match live
- `mp_event:phase_browsing` → back to lobby list
- `mp_event:phase_disconnected` → fall back to main_menu

## Pause menu (recommended)

Pin `ui/pause_menu.html` and wire via FSM (see example above). `keyboard:pause` fires on KeyP only — browser owns Escape. `ui_event:pause_menu:<action>` transitions inside `paused` return to `playing`; match-exit transitions (to main_menu) go on the parent `gameplay` state.

Configure buttons via `ui_params.pause_menu.pauseButtons`:
```json
"ui_params": {
  "pause_menu": {
    "pauseButtons": [
      { "action": "resume", "label": "Resume" },
      { "action": "main_menu", "label": "Main Menu" }
    ]
  }
}
```

## Event Definitions

All events your flow + scripts emit/listen for MUST be declared in `project/systems/event_definitions.ts`. That file is pinned with a baseline set. Add your own events following the same format:

```typescript
event_name: { fields: { fieldA: { type: 'number' }, fieldB: { type: 'string', optional: true } } }
```

Supported types: `number`, `string`, `boolean`, `object`, `any`. Keep event names lowercase snake_case and scoped to your game (`rocket_launched`, not `event1`).

**Do NOT rename or remove existing events** — engine code and reference behaviors rely on them.

## When you're done

- `validate.sh` can be run; failures about UI button names will persist until phase 4 writes the UI panels, so expect SOME errors. Focus on FSM structural validity.
- Write `handoff/phase3_complete` and exit.
