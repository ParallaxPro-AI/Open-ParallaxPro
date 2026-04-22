# PHASE 5 — VALIDATE + FIX

Your only job: run `validate.sh`, interpret failures, and fix them. Output is the final polished `project/`.

## Steps

1. `bash validate.sh`.
2. Read the output carefully. Map each failure to one of the classes below.
3. Fix with minimal, targeted edits — don't refactor. `Edit` is preferred over `Write` here (surgical changes).
4. Re-run `validate.sh`. Iterate up to 5 times. If failures persist past 5 iterations, write `handoff/phase5_failed` with a summary and exit.
5. On clean pass: write `handoff/phase5_complete` and exit.

## Failure class → fix

### 1. Asset validation failed — "not found in asset catalog"

Agent invented or mis-pasted an asset path. Fix:
- `bash search_assets.sh "<what_it_represents>"` to find a real path
- `Edit` the offending file to use the real path
- If search returns nothing close, pick a functionally similar asset or remove the ref entirely (don't leave broken paths)

### 2. UI button validation failed — `ui_event references button "X" but <panel> only has: ...`

Flow says `ui_event:<panel>:X` but `<panel>.html`'s script doesn't `emit('X')`. Fix one of:
- Edit the panel HTML to add an `emit('X')` call on a button
- Edit `01_flow.json` to change the transition to use an action the panel actually emits

### 3. Assembler Check — "Unknown entity ref"

Placement in `03_worlds.json` references an entity def not in `02_entities.json`. Fix:
- Add the entity def, OR
- Remove the placement, OR
- Rename the placement's `ref` to a def that exists

### 4. Assembler Check — "Unknown behavior / system"

`active_behaviors` in `01_flow.json` references a behavior name not in any entity's `scripts`, OR `active_systems` references a system key not in `04_systems.json`. Fix:
- Add the missing script reference to an entity in `02_entities.json`, OR remove it from `active_behaviors`
- Add the missing system to `04_systems.json`, OR remove from `active_systems`
- Remember: do NOT list `ui_bridge` or `mp_bridge` in `active_systems` (they're auto-active)

### 5. Script Syntax Check — fails TypeScript/JavaScript parse

Syntax error in a `.ts` file. Read the file, fix the specific line, re-run.

### 6. Headless Smoke Test — "Cannot read properties of undefined (reading 'emit')"

Script hallucinated an events channel. Almost always `this.scene.events.audio.emit` (doesn't exist) instead of `this.audio.playSound(path)`. Grep + replace:
```bash
grep -rn "scene.events.audio" project/
```

Other channels that DO exist: `scene.events.game`, `scene.events.ui`, and (MP only) `scene.events.net`.

### 7. Event Definitions — event name not declared

A script emits/listens for an event not in `project/systems/event_definitions.ts`. Fix:
- Add the event to `event_definitions.ts` following the existing pattern:
  ```typescript
  my_event: { fields: { amount: { type: 'number' } } }
  ```
- Do NOT rename existing baseline events — engine code relies on them.

### 8. Silent-failure watch-list checks (assembler strict)

Triggered when:
- `active_behaviors` has an entry that's not a real behavior (typo in name)
- `active_systems` has an entry that's not a real system key (typo or listed ui_bridge/mp_bridge)
- `show_ui:<panel>` where `<panel>.html` doesn't exist in `project/ui/`
- Transition `when` references an event name that's nowhere emitted
- Missing top-level `start` in FSM

## When you can't fix something

If after 5 iterations the same error class persists and you genuinely can't fix it:
1. Write a short note to `handoff/phase5_failed` describing what couldn't resolve
2. Exit with the partial project intact. The orchestrator will decide whether to retry or escalate.

Do NOT over-iterate. 5 rounds is the budget.

## When you're done (clean validate)

- Final `validate.sh` output shows "All checks passed."
- Write `handoff/phase5_complete` and exit.
