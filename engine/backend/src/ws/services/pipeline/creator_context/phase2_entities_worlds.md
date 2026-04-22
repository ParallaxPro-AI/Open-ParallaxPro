# PHASE 2 — ENTITIES + WORLDS

Your only job: fill `project/02_entities.json` and `project/03_worlds.json`. Consult `handoff/spec.json` first — it tells you the template, atmosphere, and planned entities.

## Steps

1. `cat handoff/spec.json` — the Phase 1 plan.
2. `bash library.sh show templates/<template>` — read all 4 JSONs of the chosen template for pattern reference.
3. Decide your full entity set based on spec.entities_planned. Use `bash search_assets.sh` for meshes/textures/sounds.
4. Fetch library behaviors you'll use with `bash library.sh show <path>` (or redirect to `project/behaviors/...` for verbatim copies — but prefer to read + `Write` so you can tweak).
5. Write `project/02_entities.json` and `project/03_worlds.json`.
6. Write `handoff/phase2_complete` (empty). Exit.

## 02_entities.json

Entity definitions (prefabs). Behaviors live here — each entity's `scripts` array lists which behavior files run on this entity.

```json
{
  "definitions": {
    "player": {
      "tags": ["player"],
      "mesh": { "asset": "/assets/kenney/3d_models/...", "scale": [1, 1, 1] },
      "physics": { "type": "dynamic", "freeze_rotation": true, "collider": { "shape": "capsule" } },
      "scripts": [
        { "script": "movement/platformer_movement.ts" },
        { "script": "camera/camera_platformer.ts" }
      ]
    },
    "ground": {
      "mesh": { "asset": "/assets/.../ground.glb", "scale": [50, 1, 50] },
      "physics": { "type": "static", "collider": { "shape": "box" } },
      "label": false
    }
  }
}
```

### Mesh options
- `asset` — path from `search_assets.sh` results (required unless `primitive`)
- `primitive` — `"cube"` | `"sphere"` | `"plane"` | `"cylinder"` | `"capsule"` (built-in, no asset needed)
- `scale` — `[x, y, z]` OR single number
- `color` — `[r, g, b]` for primitives

### Material overrides
```json
"mesh_override": { "color": [0.8, 0.2, 0.2], "emissive": [0.1, 0, 0], "metallic": 0.5, "roughness": 0.3 }
```

### Labels
Every entity gets a floating debug label. Set `"label": false` on ground, walls, and decorations to suppress.

### Physics (entities that move / collide)
- `dynamic` + `setVelocity()` for moving characters (NOT `setPosition`)
- `kinematic` + `setPosition()` for scripted movers (enemies, platforms)
- `static` for walls, ground
- `freeze_rotation: true` for all characters
- `collider.shape`: `"box"` | `"sphere"` | `"capsule"`. Override size via `collider.size` `[x,y,z]` or `radius`/`height`.

### Scripts

Each entry references a behavior path (relative to `behaviors/v0.1/`). Params are injected by matching `_paramName` fields on the class — prepend underscore.

```json
"scripts": [
  { "script": "movement/platformer_movement.ts", "_speed": 8, "_jumpForce": 12 }
]
```

## 03_worlds.json

Scene layout — where each entity instance is placed.

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
      { "ref": "camera", "position": [0, 6, 10] }
    ]
  }]
}
```

### Placement fields
- `ref` (required) — key in `02_entities.json definitions`
- `position` / `rotation` (euler degrees OR quaternion) / `scale`
- `name` — instance name used by `scene.findEntityByName("Player")` at runtime. Give player, camera, and script-targeted entities explicit names.
- `tags` — merged onto the def's tags
- `material_overrides` — per-placement material tweaks
- `active` — `false` to spawn inactive
- `extra_components` — extra ECS components attached verbatim (main use: lights, see below)

### Lights — spot / point / extra directional

The assembler auto-adds one directional sun. For anything else (car headlights, street lamps, torches), attach `LightComponent` via `extra_components`:

```json
{ "ref": "car", "name": "Player", "position": [0, 0.8, 0], "rotation": [0, 90, 0],
  "extra_components": [
    { "type": "LightComponent", "data": {
      "lightType": "spot",
      "color": [1.0, 0.95, 0.82],
      "intensity": 400,
      "range": 50,
      "innerConeAngle": 0.25,
      "outerConeAngle": 0.55,
      "castShadows": false
    }}
  ]
}
```

**Intensity** — engine uses inverse-square falloff `attn = clamp(1 - (d/range)^4, 0, 1)^2 / (d^2 + 1)`. Engine default of 10 is near-invisible. Start values:

| Use case | range | intensity |
|---|---|---|
| Car headlight (20-30m of road) | 40-60 | **300-600** |
| Streetlamp (10-15m radius) | 15-20 | **150-300** |
| Indoor lamp | 5-10 | **50-150** |
| Torch / firepit | 8-12 | **80-200** |

If scene looks dark, multiply intensity by 3-5× before shrinking range. Directional sun (no distance falloff): 1-5.

**Caps**: 8 point + 4 spot + 4 directional visible at once. Use sparingly.

### Night / overcast scene

If `spec.atmosphere` includes `night` or `rainy` or `overcast`:
- Drop `environment.sunIntensity` to 0.05-0.15 (kills the unseen sun)
- Drop `environment.ambientIntensity` to 0.15-0.30
- Include a system (owned by phase 3 or 4) that calls `this.scene.setTimeOfDay(22)` and `this.scene.setFog(true, [r,g,b], near, far)` on boot
- Add streetlight / headlight `LightComponent`s

## When you're done

- `validate.sh` doesn't need to pass yet (schemas not complete till phase 3 writes flow + systems)
- Write `handoff/phase2_complete` and exit
