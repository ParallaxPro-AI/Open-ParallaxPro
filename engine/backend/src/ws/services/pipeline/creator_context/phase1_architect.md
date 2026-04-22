# PHASE 1 — ARCHITECT

Your only job: pick a starting template, decide the scene atmosphere, and write an architecture spec. You are NOT filling in any game files yet.

## Steps

1. Read `TASK.md`.
2. Read `reference/game_templates/INDEX.md` — one-line summary of every template.
3. Skim the top 2-3 candidate templates' `01_flow.json` to pick the best starting point (do not read all 4 JSONs yet — later phases do that).
4. Decide:
   - `template` — the starting template id
   - `is_multiplayer` — true if prompt needs networking
   - `atmosphere` — scene mood in 1-3 tags (e.g. `night`, `rainy`, `underwater`, `sunny`, `neon`, `indoor_warm`, `space`)
   - `entities_planned` — short list of entity names you'll need (player, NPCs, props, light sources, etc.)
   - `systems_planned` — short list of game-logic systems (score, spawner, combat, etc.)
   - `behaviors_planned` — short list of custom behaviors (movement style, camera, AI)
   - `custom_ui_panels` — custom UI beyond the reusable main_menu/pause/game_over
   - `fsm_skeleton` — rough FSM state sketch
   - `notes` — 1-3 sentence description of the game
5. Write `handoff/spec.json` exactly matching the schema below.
6. Run nothing else. **Do not touch `project/*`.** That's the next phase's job.

## handoff/spec.json schema

```json
{
  "template": "<template_id>",
  "is_multiplayer": false,
  "atmosphere": ["night", "rainy"],
  "entities_planned": ["player_car", "streetlight", "traffic_cone", "..."],
  "systems_planned": ["drive_manager", "night_scene"],
  "behaviors_planned": ["car_control", "chase_camera"],
  "custom_ui_panels": ["speedometer"],
  "fsm_skeleton": [
    "boot",
    "main_menu",
    "gameplay (playing | paused)",
    "game_over"
  ],
  "notes": "Night rainstorm coastal highway. Dark wet asphalt, headlights, streetlamps. Drive freely — no objective."
}
```

## Tips

- Don't over-spec. The list fields are a *guide* for later phases — they'll refine based on what the library has.
- If multiple templates could work, pick the one with the closest genre/shape match, preferring simpler ones for clearer phase-2 work.
- For multiplayer prompts, `multiplayer_coin_grab` is the minimal exemplar; `buccaneer_bay` is richer (lobby + voice). Pick by vibe.

## When you're done

Write `handoff/spec.json`. Write `handoff/phase1_complete` (empty file — the sentinel). Then exit.
