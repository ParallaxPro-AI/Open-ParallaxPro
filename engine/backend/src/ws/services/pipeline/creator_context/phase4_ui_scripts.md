# PHASE 4 — UI + CUSTOM SCRIPTS

Your job: write the HTML UI panels (`project/ui/*.html`) and any custom behaviors / systems referenced by prior phases' JSONs (`project/behaviors/**/*.ts`, `project/systems/**/*.ts`). You may PATCH `project/01_flow.json` to fix UI button name mismatches — that's allowed here.

## Steps

1. `cat handoff/spec.json` + read all 4 project JSONs written by phases 2 and 3.
2. Inventory what the JSONs reference but don't yet exist:
   - `active_behaviors` in 01_flow → each must be a behavior `script` path referenced in 02_entities, with a file at `project/behaviors/<path>`
   - `active_systems` in 01_flow → each must be a key in 04_systems with a file at `project/systems/<path>`
   - `show_ui:<panel>` in 01_flow → each needs `project/ui/<panel>.html` (pinned from library OR custom)
   - Every `ui_event:<panel>:<action>` transition → needs `emit('<action>')` literal in `<panel>.html`'s script
3. For each missing UI panel: copy from library (`library.sh show ui/<panel>.html > project/ui/<panel>.html`) or write custom.
4. For each missing behavior / system: copy from library or write custom.
5. Run `bash validate.sh`. Fix errors. Re-run.
6. Write `handoff/phase4_complete` and exit.

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
4. Params inject via matching `_paramName` fields (prepend underscore)
5. Behaviors have `_behaviorName`; engine auto-activates based on FSM's `active_behaviors`

## Script API

### Lifecycle
- `onStart()` — once when behavior/system becomes active
- `onUpdate(dt)` — every frame
- `onLateUpdate(dt)` — after all `onUpdate`s (cameras, UI follow)
- `onFixedUpdate(fixedDt)` — physics-sensitive
- `onDestroy()` — cleanup
- `onCollisionEnter/Stay/Exit(otherId)` — physics collisions
- `onTriggerEnter/Stay/Exit(otherId)` — trigger volumes

### System vs behavior activation — timing gotcha

- **Behaviors** `onStart` at scene load, before any FSM transition.
- **Systems** `onStart` only *after* the FSM enters a state that lists them in `active_systems`.

Trap: if a state's `on_enter` emits an event AND that state is what activates the system, the listener isn't registered yet and the emit is lost (events don't queue).

**Rule**: a system's first-time init runs directly **in `onStart`**, not behind an event fired from the activating state. Use events only for things that happen *after* the system is already running (e.g. `restart_game` from a button).

```js
class MyGameSystem extends GameScript {
    _active = false;
    onStart() {
        var self = this;
        this._startMatch();                                   // first-time init
        this.scene.events.game.on("restart_game", function() { self._startMatch(); });
    }
    _startMatch() { this._active = true; /* reset state */ }
    onUpdate(dt) { if (!this._active) return; /* ... */ }
}
```

### `this.entity` (own entity)

```js
this.entity.id              // numeric id
this.entity.name            // instance name
this.entity.tags            // tag array
this.entity.transform       // Transform
this.entity.hasTag(tag)
this.entity.setActive(bool)
this.entity.destroy()
this.entity.playAnimation(name, { loop: true })
this.entity.getComponent(type)     // e.g. "LightComponent"
```

### `this.scene`

```js
this.scene.findEntityByName("Player")      // returns ScriptEntity | null
this.scene.findEntitiesByName("Enemy")     // returns array
this.scene.findEntitiesByTag("enemy")      // tag filter
this.scene.getAllEntities()
this.scene.createEntity(defName)           // bare create, NOT validated
this.scene.spawnEntity(defName, options)   // validated — see spawn validator
this.scene.destroyEntity(id)
this.scene.setPosition(id, x, y, z)
this.scene.setVelocity(id, { x, y, z })
this.scene.setRotationEuler(id, x, y, z)
this.scene.setScale(id, x, y, z)
this.scene.raycast(origin, dir, { maxDist })          // from world point
this.scene.screenRaycast(screenX, screenY)            // from camera
this.scene.screenPointToGround(x, y, 0)               // project onto Y-plane
this.scene.getTerrainHeight(x, z)
this.scene.getTerrainNormal(x, z)
this.scene.setFog(enabled, color, near, far)
this.scene.setTimeOfDay(hour)                         // 0-24, dims skybox + lighting
this.scene.loadScene("other_scene")
this.scene.saveData("key", value)
this.scene.loadData("key")
this.scene.deleteData("key")
```

### Events

`this.scene.events` has three channels: `game`, `ui`, and (MP only) `net`.

```js
this.scene.events.game.emit("event_name", { payload })
this.scene.events.game.on("event_name", function(data) { ... })
this.scene.events.ui.emit("hud_update", { score: 42 })
this.scene.events.net.emit("net_msg", { ... })       // MP only
```

There is NO `scene.events.audio` — audio is `this.audio.*`.

### `this.input`

```js
this.input.isKeyDown("KeyW")            // WASD, Space, ShiftLeft, ArrowUp, etc.
this.input.isKeyPressed("KeyE")         // one-shot (true the frame it went down)
this.input.mouseButton(0)               // 0=left, 1=middle, 2=right
this.input.mouseDelta()                 // { x, y } since last frame
this.input.mousePosition()              // { x, y } screen-space
this.input.pointerLocked                // bool
```

Common keys: `KeyW/A/S/D`, `ArrowUp/Down/Left/Right`, `Space`, `ShiftLeft`, `ControlLeft`, `KeyE` (interact), `KeyP` (pause), `KeyQ/R`, digits `Digit1`-`Digit9`.

### `this.audio`

```js
this.audio.playSound(path, volume)     // volume 0..1
this.audio.playMusic(path, volume)     // loops automatically
this.audio.stopMusic()
```

### `this.ui`

```js
var t = this.ui.createText({ text: "Hello", x: 20, y: 20, color: "#fff" })
t.text = "Updated"; t.remove()
```

### `this.time`
```js
this.time.now            // seconds since scene start
this.time.delta          // seconds since last frame (same as onUpdate's dt)
```

### Reserved keys — DO NOT use for gameplay
The FSM driver emits `state_changed` every frame with `phase` (current state name) and any `set:` vars. If your `hud_update` sets `phase` or any name you've `set:`d, the FSM overwrites your value next tick — pick scoped names instead.

| Key | Written by | Holds |
|---|---|---|
| `phase` | FSM driver | current FSM state name |
| any `set:x=y` var | FSM driver | the FSM variable |

## UI Panels (HTML)

Panels are static HTML + CSS + JS. They listen for `state_changed` messages from the engine and emit actions via `postMessage` back. The assembler auto-wires a helper `emit(action)` for you.

### State keys the reusable HUDs expect

When you pin a reusable HUD, your game systems must emit the keys that panel reads. Mismatched/missing keys = blank display. Common ones:

| Panel | Required state keys |
|---|---|
| `hud/vitals` | `health`, `maxHealth`, `hunger`, `maxHunger` |
| `hud/hotbar` | `hotbarItems` (array), `selectedSlot` |
| `hud/scoreboard` | `players` (array with `name`, `score`) |
| `hud/ammo` | `ammo`, `maxAmmo` |
| `hud/crosshair` | — (static) |

Custom HUDs: pick your own key names, stay consistent between emitter and panel.

### Button actions — validator rule

Buttons emit commands via `window.parent.postMessage`, but the assembler's static validator only recognizes a button if a matching `emit('literal_action')` call appears in the panel's `<script>`. It does NOT scan `postMessage(...)` calls or dynamic `emit(variable)` calls.

Required pattern — define `emit()` once, call it with a string literal per distinct action:

```html
<script>
(function(){
  function emit(action) {
    window.parent.postMessage({ type: 'ui_event', panel: 'pause_menu', action: action }, '*');
  }
  document.getElementById('btn-resume').addEventListener('click', function() { emit('resume'); });
  document.getElementById('btn-main-menu').addEventListener('click', function() { emit('main_menu'); });
})();
</script>
```

### Inline `onclick` and IIFE scoping

Inline `onclick="fn(...)"` looks up `fn` on `window`. If your script is in an IIFE, `fn` is hidden and clicks throw `ReferenceError` silently. Fix: either `window.fn = fn;` inside the IIFE, or use `addEventListener('click', ...)` everywhere (preferred). Don't mix styles in one panel.

### Clickable HUD elements — virtual cursor support

During gameplay the browser's pointer is locked to the canvas. The engine draws a "virtual cursor" that the game controls. For any HUD button that's clickable during gameplay:
- Add `data-click="true"` attribute
- The engine's virtual cursor will route to the element

### Spawn entity — validator rule

If your script does `scene.spawnEntity("enemy_type")` with dynamic names, the validator can't statically verify they exist. Add a `__validatorManifest()` method listing every name you might spawn:

```js
class MyWaveSystem extends GameScript {
    onUpdate(dt) {
        if (shouldSpawn) this.scene.spawnEntity(this._pickRandomEnemy());
    }
    __validatorManifest() {
        this.scene.spawnEntity("enemy_slime");
        this.scene.spawnEntity("enemy_skeleton");
        this.scene.spawnEntity("enemy_bat");
    }
}
```

For genuinely blank entities (rare), use `scene.createEntity(name)` — bare-create path, not validated.

### Sharing state across behaviors (`scene._*` convention)

Scripts on different entities can cross-reference state via `this.scene._<name>`:

```js
// camera_third_person.ts
onUpdate(dt) {
    this.scene._tpYaw = this._yawDeg;  // writes the camera yaw
}

// platformer_movement.ts
onUpdate(dt) {
    var yaw = (this.scene._tpYaw || 0) * Math.PI / 180;  // reads it
    // compute movement relative to camera...
}
```

Keep these names documented informally; don't overload common words.

## Common failures this phase triggers (fix BEFORE validate)

1. **UI button mismatch** — grep each panel's `<script>` for every action name the flow's `ui_event:panel:X` transitions want. Use the `emit('X')` literal pattern.
2. **Missing `__validatorManifest`** for dynamic spawns.
3. **`scene.events.audio.emit`** — doesn't exist. Audio is `this.audio.playSound/playMusic`.
4. **Undeclared events** — every event emitted/listened must exist in `project/systems/event_definitions.ts`. Add new ones there, don't rename existing ones.
5. **Behaviors referenced in `active_behaviors` but not present** as an entity script on any placement — validator catches it.

## When you're done

- Run `bash validate.sh` and fix every error.
- Write `handoff/phase4_complete` and exit.
