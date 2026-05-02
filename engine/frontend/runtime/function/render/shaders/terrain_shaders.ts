/**
 * terrain_shaders.ts — Dedicated fragment shaders for heightmap terrain.
 *
 * Renders terrain with:
 *   - 4-layer PBR ground texturing blended by a ground-type weight map
 *     (texture_2d with RGBA weights: sand, grass, grass/rock, rock)
 *   - Height + slope fallback when no weight map is supplied
 *   - Road atlas overlay (asphalt + sidewalk hint) via two 2D tiled atlases
 *   - Optional sidewalk concrete texture overlay
 *   - Per-pixel water below a configurable world-space Y threshold
 *     (FBM wave normals, depth-based color, sky reflection, sun specular)
 *   - Cascaded shadow maps, fog, Reinhard tone-map — matching the PBR pipeline
 *
 * Bind group layout (group 2):
 *   0: material uniform  1: roadAtlasNear  2: sampler  3: roadAtlasFar
 *   4: groundDiffuse (2d-array)  5: groundNormal (2d-array)
 *   6: layerProps uniform  7: sidewalkDiffuse  8: sidewalkNormal
 *   9: groundTypeMap (weight map, or default black for height-only fallback)
 *
 * The weight map is optional — supply a 1×1 black texture to use the
 * height/slope-based layer weights.
 */

const TERRAIN_PBR_COMMON = /* wgsl */ `
const PI: f32 = 3.14159265359;

// ── Structs ──────────────────────────────────────────────────

struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    _pad0: f32,
    cascadeMatrices: array<mat4x4<f32>, 4>,
    cascadeSplits: vec4<f32>,
};

struct MaterialUniforms {
    baseColor: vec4<f32>,
    metallic: f32,
    roughness: f32,
    hasBaseColorTexture: u32,
    hasNormalMap: u32,
    emissive: vec3<f32>,
    normalScale: f32,
    waterEffect: u32,
    uvScaleX: f32,
    uvScaleY: f32,
    terrainHeightColor: u32,
    // Layout-only; mirrors PBR MaterialUniforms (waterScale + 12 bytes pad)
    // so a single 80-byte uniform buffer feeds either shader.
    _terrainPadW: f32,
    _terrainPad0: f32,
    _terrainPad1: f32,
    _terrainPad2: f32,
};

struct DirectionalLight {
    direction: vec3<f32>,
    _pad0: f32,
    color: vec3<f32>,
    intensity: f32,
};

struct PointLight {
    position: vec3<f32>,
    range: f32,
    color: vec3<f32>,
    intensity: f32,
};

struct SpotLight {
    position: vec3<f32>,
    range: f32,
    direction: vec3<f32>,
    intensity: f32,
    color: vec3<f32>,
    outerCone: f32,
    innerCone: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

struct LightUniforms {
    ambientColor: vec3<f32>,
    ambientIntensity: f32,
    numDirectionalLights: u32,
    numPointLights: u32,
    numSpotLights: u32,
    shadowEnabled: u32,
    shadowBias: f32,
    shadowMapSize: f32,
    fogEnabled: u32,
    fogNear: f32,
    fogFar: f32,
    time: f32,
    _pad1: f32,
    _pad2: f32,
    fogColor: vec3<f32>,
    _pad3: f32,
    directionalLights: array<DirectionalLight, 4>,
    pointLights: array<PointLight, 8>,
    spotLights: array<SpotLight, 4>,
};

// layerProps.data layout:
//   [0..3].x  = UV tiling scale for ground layers 0-3
//   [4].xy    = reserved
//   [5].xy    = world dimensions (meters) for the weight map UV clamp
struct TerrainLayerProps {
    data: array<vec4<f32>, 8>,
};

// ── Bindings ─────────────────────────────────────────────────

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

@group(2) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(1) var roadAtlasNear: texture_2d<f32>;
@group(2) @binding(2) var terrainSampler: sampler;
@group(2) @binding(3) var roadAtlasFar: texture_2d<f32>;
@group(2) @binding(4) var groundDiffuse: texture_2d_array<f32>;
@group(2) @binding(5) var groundNormal: texture_2d_array<f32>;
@group(2) @binding(6) var<uniform> layerProps: TerrainLayerProps;
@group(2) @binding(7) var sidewalkDiffuse: texture_2d<f32>;
@group(2) @binding(8) var sidewalkNormal: texture_2d<f32>;
@group(2) @binding(9) var groundTypeMap: texture_2d<f32>;

@group(3) @binding(0) var<uniform> lights: LightUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d_array;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

// ── I/O ──────────────────────────────────────────────────────

struct FragmentInput {
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

struct PBRResult {
    color: vec4<f32>,
    normal: vec3<f32>,
};

// ── Noise ────────────────────────────────────────────────────

fn hash2D(p: vec2<f32>) -> vec2<f32> {
    let k = vec2<f32>(0.3183099, 0.3678794);
    var q = p * k + vec2<f32>(k.y, k.x);
    q = fract(q * 43758.5453);
    return fract(q * vec2<f32>(q.y + 71.0, q.x + 113.0)) * 2.0 - 1.0;
}

fn hash1(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(127.1, 311.7))) * 43758.5453);
}

fn gradientNoise(p: vec2<f32>) -> f32 {
    let i = floor(p);
    let f = fract(p);
    let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    let ga = hash2D(i);
    let gb = hash2D(i + vec2<f32>(1.0, 0.0));
    let gc = hash2D(i + vec2<f32>(0.0, 1.0));
    let gd = hash2D(i + vec2<f32>(1.0, 1.0));
    let va = dot(ga, f);
    let vb = dot(gb, f - vec2<f32>(1.0, 0.0));
    let vc = dot(gc, f - vec2<f32>(0.0, 1.0));
    let vd = dot(gd, f - vec2<f32>(1.0, 1.0));
    return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

fn fbmTerrain(p: vec2<f32>) -> f32 {
    var val = 0.0;
    var amp = 0.5;
    var pos = p;
    let rot = mat2x2<f32>(0.8, 0.6, -0.6, 0.8);
    for (var i = 0; i < 4; i = i + 1) {
        val = val + gradientNoise(pos) * amp;
        pos = rot * pos * 2.07;
        amp = amp * 0.48;
    }
    return val;
}

// ── Shadow ───────────────────────────────────────────────────

fn sampleShadowCascade(worldPos: vec3<f32>, normal: vec3<f32>, cascade: i32) -> f32 {
    let lightSpaceMatrix = camera.cascadeMatrices[cascade];
    let normalBias = 0.005 * f32(cascade + 1);
    let biasedPos = vec4<f32>(worldPos + normalize(normal) * normalBias, 1.0);
    let lightSpacePos = lightSpaceMatrix * biasedPos;

    let projCoords = lightSpacePos.xyz / lightSpacePos.w;
    let shadowUV = vec2<f32>(projCoords.x * 0.5 + 0.5, 1.0 - (projCoords.y * 0.5 + 0.5));
    let currentDepth = projCoords.z;

    let lightDir = normalize(lights.directionalLights[0].direction);
    let NdotL = max(dot(normal, -lightDir), 0.0);
    let bias = max(lights.shadowBias * (1.0 - NdotL), 0.0001);

    let texelSize = 1.0 / lights.shadowMapSize;
    var shadow = 0.0;
    shadow += textureSampleCompareLevel(shadowMap, shadowSampler, shadowUV + vec2(-texelSize, -texelSize), cascade, currentDepth - bias);
    shadow += textureSampleCompareLevel(shadowMap, shadowSampler, shadowUV + vec2( texelSize, -texelSize), cascade, currentDepth - bias);
    shadow += textureSampleCompareLevel(shadowMap, shadowSampler, shadowUV + vec2(-texelSize,  texelSize), cascade, currentDepth - bias);
    shadow += textureSampleCompareLevel(shadowMap, shadowSampler, shadowUV + vec2( texelSize,  texelSize), cascade, currentDepth - bias);
    shadow = shadow * 0.25;

    let outOfBounds = currentDepth < 0.0 || currentDepth > 1.0 ||
        shadowUV.x < 0.0 || shadowUV.x > 1.0 ||
        shadowUV.y < 0.0 || shadowUV.y > 1.0;
    return select(shadow, 1.0, outOfBounds);
}

fn computeShadow(worldPos: vec3<f32>, normal: vec3<f32>) -> f32 {
    if (lights.shadowEnabled == 0u) { return 1.0; }

    let viewPos = camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let depth = -viewPos.z;

    var cascade = 0;
    if (depth > camera.cascadeSplits.x) { cascade = 1; }
    if (depth > camera.cascadeSplits.y) { cascade = 2; }
    if (depth > camera.cascadeSplits.z) { cascade = 3; }
    if (depth > camera.cascadeSplits.w) { return 1.0; }

    let shadow = sampleShadowCascade(worldPos, normal, cascade);

    let cascadeFar = camera.cascadeSplits[cascade];
    let cascadeNear = select(camera.cascadeSplits[cascade - 1], 0.0, cascade == 0);
    // 20% blend (was 10%) — narrower band was too abrupt, seams between
    // cascades showed as visible lines on terrain.
    let blendZone = (cascadeFar - cascadeNear) * 0.2;
    let distToEdge = cascadeFar - depth;

    if (distToEdge < blendZone && cascade < 3) {
        let nextShadow = sampleShadowCascade(worldPos, normal, cascade + 1);
        return mix(nextShadow, shadow, distToEdge / blendZone);
    }
    return shadow;
}

// ── Direct lighting ──────────────────────────────────────────

fn computeDirectLighting(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, F0: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32, radiance: vec3<f32>) -> vec3<f32> {
    let H = normalize(V + L);
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let denom = (NdotH * NdotH * (a2 - 1.0) + 1.0);
    let NDF = a2 / (PI * denom * denom);
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    let G = (NdotV / (NdotV * (1.0 - k) + k)) * (NdotL / (NdotL * (1.0 - k) + k));
    let F = F0 + (1.0 - F0) * pow(clamp(1.0 - max(dot(H, V), 0.0), 0.0, 1.0), 5.0);
    let specular = (NDF * G * F) / (4.0 * NdotV * NdotL + 0.0001);
    var kD = (vec3<f32>(1.0) - F) * (1.0 - metallic);
    return (kD * albedo / PI + specular) * radiance * NdotL;
}

// ── Fog ──────────────────────────────────────────────────────

fn applyFog(color: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
    let dist = distance(camera.cameraPosition, worldPos);
    let fogFactor = clamp((lights.fogFar - dist) / (lights.fogFar - lights.fogNear), 0.0, 1.0);
    return mix(lights.fogColor, color, fogFactor);
}

// ── Normal map ───────────────────────────────────────────────

fn perturbNormalFromMap(N: vec3<f32>, worldPos: vec3<f32>, texUV: vec2<f32>, mapN: vec3<f32>) -> vec3<f32> {
    let dp1 = dpdx(worldPos);
    let dp2 = dpdy(worldPos);
    let duv1 = dpdx(texUV);
    let duv2 = dpdy(texUV);
    let dp2perp = cross(dp2, N);
    let dp1perp = cross(N, dp1);
    let T = dp2perp * duv1.x + dp1perp * duv2.x;
    let B = dp2perp * duv1.y + dp1perp * duv2.y;
    let invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
    let TBN = mat3x3<f32>(T * invmax, B * invmax, N);
    return normalize(TBN * mapN);
}

// ── Ground layer sampling ────────────────────────────────────

struct GroundSample {
    albedo: vec3<f32>,
    normal: vec3<f32>,
    roughness: f32,
};

fn sampleGroundLayer(layerIdx: i32, worldXZ: vec2<f32>, N: vec3<f32>, worldPos: vec3<f32>) -> GroundSample {
    var gs: GroundSample;
    let uvScale = layerProps.data[layerIdx].x;
    let texUV = worldXZ * uvScale;
    let diff = textureSample(groundDiffuse, terrainSampler, texUV, layerIdx);
    gs.albedo = diff.rgb;
    gs.roughness = 0.85;
    var nm = textureSample(groundNormal, terrainSampler, texUV, layerIdx).xyz * 2.0 - 1.0;
    nm.x *= 2.0;
    nm.y *= 2.0;
    gs.normal = perturbNormalFromMap(N, worldPos, texUV, nm);
    return gs;
}

// ── Road atlas sampling ──────────────────────────────────────

struct RoadInfo {
    coverage: f32,
    centerDist: f32,
    sidewalkCov: f32,
    sidewalkEdgeDist: f32,
};

fn sampleRoadAtlas(worldPos: vec3<f32>) -> RoadInfo {
    var ri: RoadInfo;
    let chunkSize = 500.0;
    let chunkX = floor(worldPos.x / chunkSize);
    let chunkZ = floor(worldPos.z / chunkSize);
    let localU = fract(worldPos.x / chunkSize);
    let localV = fract(worldPos.z / chunkSize);

    let nearGrid = 8.0;
    let ntX = ((chunkX % nearGrid) + nearGrid) % nearGrid;
    let ntZ = ((chunkZ % nearGrid) + nearGrid) % nearGrid;
    let nearUV = vec2<f32>((ntX + localU) / nearGrid, (ntZ + localV) / nearGrid);

    let farGrid = 32.0;
    let ftX = ((chunkX % farGrid) + farGrid) % farGrid;
    let ftZ = ((chunkZ % farGrid) + farGrid) % farGrid;
    let farUV = vec2<f32>((ftX + localU) / farGrid, (ftZ + localV) / farGrid);

    var nearSample = vec4<f32>(0.0);
    var farSample = vec4<f32>(0.0);
    if (material.hasBaseColorTexture > 0u) {
        nearSample = textureSample(roadAtlasNear, terrainSampler, nearUV);
    }
    if (material.hasNormalMap > 0u) {
        farSample = textureSample(roadAtlasFar, terrainSampler, farUV);
    }

    ri.coverage = nearSample.r;
    ri.centerDist = nearSample.g;
    ri.sidewalkCov = nearSample.b;
    ri.sidewalkEdgeDist = nearSample.a;
    if (ri.coverage < 0.01) {
        ri.coverage = farSample.r;
        ri.centerDist = farSample.g;
    }
    if (ri.sidewalkCov < 0.01) {
        ri.sidewalkCov = farSample.b;
        ri.sidewalkEdgeDist = farSample.a;
    }
    return ri;
}

// ── Layer weight computation ─────────────────────────────────
//
// Layer 0: Sand      ~0–7m
// Layer 1: Grass     ~2–40m
// Layer 2: Grass/Rock ~40–150m
// Layer 3: Rock      ~150m+
//
// When a non-zero weight map is provided (layerProps.data[5].xy > 0),
// its RGBA channels are used directly. Falls back to height+slope weights
// for pixels outside the map extent or when no map is bound.

fn computeLayerWeights(h: f32, slopeY: f32, worldXZ: vec2<f32>, naipW: vec4<f32>) -> vec4<f32> {
    let naipTotal = naipW.x + naipW.y + naipW.z + naipW.w;

    var weights: vec4<f32>;

    if (naipTotal > 0.05) {
        weights = naipW / naipTotal;
    } else {
        // Height + noise fallback
        let n1 = fbmTerrain(worldXZ * 0.012) * 12.0;
        let n2 = gradientNoise(worldXZ * 0.04) * 6.0;
        let noiseOffset = n1 + n2;
        let hN = h + noiseOffset;

        let w0 = smoothstep(7.0, 0.5, hN);
        let w1 = smoothstep(0.5, 3.0, hN) * smoothstep(80.0, 40.0, hN);
        let w2 = smoothstep(30.0, 55.0, hN) * smoothstep(250.0, 150.0, hN);
        let w3 = smoothstep(120.0, 180.0, hN);
        weights = vec4<f32>(w0, w1, w2, w3);
    }

    // Slope override: steep faces shift toward rock
    let slopeFactor = smoothstep(0.7, 0.35, abs(slopeY));
    weights = mix(weights, vec4<f32>(0.0, 0.0, 0.15, 0.85), slopeFactor);

    let total = weights.x + weights.y + weights.z + weights.w;
    if (total > 0.001) {
        weights = weights / total;
    } else {
        weights = vec4<f32>(0.0, 1.0, 0.0, 0.0);
    }
    return weights;
}

// ── Main PBR computation ─────────────────────────────────────

fn computeTerrainPBR(input: FragmentInput) -> PBRResult {
    let h = input.worldPosition.y;
    var N = normalize(input.worldNormal);
    let worldXZ = input.worldPosition.xz;

    // All texture samples before any non-uniform branching (WGSL requirement)
    let road = sampleRoadAtlas(input.worldPosition);
    let s0 = sampleGroundLayer(0, worldXZ, N, input.worldPosition);
    let s1 = sampleGroundLayer(1, worldXZ, N, input.worldPosition);
    let s2 = sampleGroundLayer(2, worldXZ, N, input.worldPosition);
    let s3 = sampleGroundLayer(3, worldXZ, N, input.worldPosition);

    // Sidewalk concrete (~2m tiling); sampled unconditionally
    let swUV = worldXZ * 0.5;
    let swDiff = textureSample(sidewalkDiffuse, terrainSampler, swUV);
    var swNrm = textureSample(sidewalkNormal, terrainSampler, swUV).xyz * 2.0 - 1.0;
    swNrm.x *= 1.5;
    swNrm.y *= 1.5;
    let swNormal = perturbNormalFromMap(vec3<f32>(0.0, 1.0, 0.0), input.worldPosition, swUV, swNrm);

    // Splatmap UV — the ground-type splatmap is aligned 1:1 with the full
    // extended heightmap. layerProps[5].xy is the extent in metres, .zw is
    // the heightmap NW-corner origin in world coords (typically negative,
    // since OSM content is pinned at world (0,0)).
    let worldDim = vec2<f32>(layerProps.data[5].x, layerProps.data[5].y);
    let worldOrigin = vec2<f32>(layerProps.data[5].z, layerProps.data[5].w);
    let weightUV = (worldXZ - worldOrigin) / worldDim;
    // Clamp keeps the texture access in-range under uniform control flow;
    // any fragment actually rendered should already be in [0,1] because the
    // terrain mesh matches the heightmap extent.
    let weightUVClamped = clamp(weightUV, vec2<f32>(0.0), vec2<f32>(1.0));
    let weightSample = textureSample(groundTypeMap, terrainSampler, weightUVClamped);

    // Road atlas mask — atlas only covers the OSM content sub-region, which
    // sits at world (0,0)→(contentDim). Outside that, the atlas would tile
    // wilderness with phantom roads, so zero its contribution.
    let contentDim = vec2<f32>(layerProps.data[6].x, layerProps.data[6].y);
    // contentDim == 0 → mask disabled (no OSM region configured).
    let inOsm = contentDim.x <= 0.0 || contentDim.y <= 0.0
             || (worldXZ.x >= 0.0 && worldXZ.x <= contentDim.x
              && worldXZ.y >= 0.0 && worldXZ.y <= contentDim.y);
    var roadMasked = road;
    if (!inOsm) {
        roadMasked.coverage = 0.0;
        roadMasked.sidewalkCov = 0.0;
    }

    let weights = computeLayerWeights(h, N.y, worldXZ, weightSample);

    var isWater = false;
    var albedo = vec3<f32>(0.3, 0.5, 0.25);
    var roughness = 0.85;
    var metallic = 0.0;
    var alpha = 1.0;

    if (h <= 0.5) {
        // Ocean / sea-level water
        albedo = vec3<f32>(0.06, 0.15, 0.30);
        roughness = 0.15;
        metallic = 0.02;
        isWater = true;
    } else {
        var blendedAlbedo = s0.albedo * weights.x + s1.albedo * weights.y + s2.albedo * weights.z + s3.albedo * weights.w;
        var blendedNormal = s0.normal * weights.x + s1.normal * weights.y + s2.normal * weights.z + s3.normal * weights.w;
        var blendedRoughness = s0.roughness * weights.x + s1.roughness * weights.y + s2.roughness * weights.z + s3.roughness * weights.w;

        let microNoise = gradientNoise(worldXZ * 0.005) * 0.08;
        blendedAlbedo = blendedAlbedo * (1.0 + microNoise);

        albedo = blendedAlbedo;
        roughness = blendedRoughness;
        N = normalize(blendedNormal);

        // Road overlay
        if (roadMasked.coverage > 0.01) {
            let rc = saturate(roadMasked.coverage);
            let asphaltNoise = gradientNoise(worldXZ * 0.8) * 0.03;
            let asphaltColor = vec3<f32>(0.20 + asphaltNoise, 0.20 + asphaltNoise, 0.22 + asphaltNoise);
            albedo = mix(albedo, asphaltColor, rc);
            roughness = mix(roughness, 0.92, rc);
            metallic = mix(metallic, 0.0, rc);
            N = mix(N, vec3<f32>(0.0, 1.0, 0.0), rc * 0.8);
        }

        // Sidewalk hint — subtle far-LOD tint
        if (roadMasked.sidewalkCov > 0.01) {
            let sc = saturate(roadMasked.sidewalkCov) * 0.3;
            let hintColor = vec3<f32>(0.65, 0.63, 0.60);
            albedo = mix(albedo, hintColor, sc);
        }
    }

    // Water surface
    if (isWater) {
        let t = lights.time;
        let windDir = vec2<f32>(0.7, 0.3);
        let windSpeed = 1.2;
        let waterPos = input.worldPosition.xz * 3.0 + windDir * t * windSpeed * 0.6;
        let camDist = distance(camera.cameraPosition, input.worldPosition);

        let eps = 0.8;
        let wh = fbmTerrain(waterPos);
        let whx = fbmTerrain(waterPos + vec2<f32>(eps, 0.0));
        let whz = fbmTerrain(waterPos + vec2<f32>(0.0, eps));
        N = normalize(vec3<f32>((wh - whx) / eps, 1.0, (wh - whz) / eps));

        let swell1 = cos(input.worldPosition.x * 0.015 + input.worldPosition.z * 0.025 + t * 0.3) * 0.06;
        let swell2 = cos(input.worldPosition.x * 0.02 - input.worldPosition.z * 0.015 + t * 0.4) * 0.04;
        N = normalize(N + vec3<f32>(swell1, 0.0, swell2));

        let normalFade = clamp(camDist / 800.0, 0.0, 0.85);
        N = normalize(mix(N, vec3<f32>(0.0, 1.0, 0.0), normalFade));

        let deepColor = vec3<f32>(0.008, 0.035, 0.10);
        let shallowColor = vec3<f32>(0.04, 0.22, 0.30);
        let V_up = normalize(camera.cameraPosition - input.worldPosition);
        let viewDot = max(dot(vec3<f32>(0.0, 1.0, 0.0), V_up), 0.0);
        let depthFactor = pow(1.0 - viewDot, 3.0);
        let colorVar = gradientNoise(input.worldPosition.xz * 0.003) * 0.06;
        albedo = mix(deepColor, shallowColor, depthFactor + colorVar);
        alpha = mix(0.85, 0.97, depthFactor);
        roughness = 0.01;
        metallic = 0.0;
    }

    // ── Lighting ─────────────────────────────────────────────
    let V = normalize(camera.cameraPosition - input.worldPosition);
    let F0 = mix(vec3<f32>(0.04), albedo, metallic);

    var Lo = vec3<f32>(0.0);
    let shadowFactor = computeShadow(input.worldPosition, N);

    let numDirLights = min(lights.numDirectionalLights, 4u);
    for (var i = 0u; i < numDirLights; i = i + 1u) {
        let light = lights.directionalLights[i];
        let L = normalize(-light.direction);
        let radiance = light.color * light.intensity;
        let sf = select(1.0, shadowFactor, i == 0u);
        Lo = Lo + computeDirectLighting(N, V, L, F0, albedo, metallic, roughness, radiance) * sf;
    }

    let numPtLights = min(lights.numPointLights, 8u);
    for (var i = 0u; i < numPtLights; i = i + 1u) {
        let light = lights.pointLights[i];
        let lightVec = light.position - input.worldPosition;
        let dist = length(lightVec);
        let L = normalize(lightVec);
        let d2 = dist * dist;
        let r2 = light.range * light.range;
        let attn0 = clamp(1.0 - d2 * d2 / (r2 * r2), 0.0, 1.0);
        let attn = attn0 * attn0 / (d2 + 1.0);
        let radiance = light.color * light.intensity * attn;
        Lo = Lo + computeDirectLighting(N, V, L, F0, albedo, metallic, roughness, radiance);
    }

    let ambient = lights.ambientColor * lights.ambientIntensity * albedo;
    var color = ambient + Lo + material.emissive;

    // Water Fresnel + sky reflection + sun specular
    if (isWater) {
        let NdotV = max(dot(N, V), 0.001);
        let F0_water = vec3<f32>(0.02);
        let fresnel = F0_water + (vec3<f32>(1.0) - F0_water) * pow(1.0 - NdotV, 5.0);
        let reflectDir = reflect(-V, N);
        let skyY = max(reflectDir.y, 0.0);
        let horizonHaze = vec3<f32>(0.6, 0.72, 0.82);
        let skyMid = vec3<f32>(0.35, 0.55, 0.80);
        let skyZenith = vec3<f32>(0.18, 0.35, 0.68);
        var skyReflect = mix(horizonHaze, skyMid, smoothstep(0.0, 0.3, skyY));
        skyReflect = mix(skyReflect, skyZenith, smoothstep(0.3, 0.8, skyY));
        let belowHorizon = max(-reflectDir.y, 0.0);
        skyReflect = mix(skyReflect, vec3<f32>(0.01, 0.04, 0.08), smoothstep(0.0, 0.3, belowHorizon));
        color = mix(color, skyReflect, fresnel);

        let numDL = min(lights.numDirectionalLights, 1u);
        for (var li = 0u; li < numDL; li = li + 1u) {
            let sunDir = normalize(-lights.directionalLights[li].direction);
            let H = normalize(V + sunDir);
            let NdotH = max(dot(N, H), 0.0);
            let waterRough = 0.03;
            let wa2 = waterRough * waterRough;
            let wdenom = NdotH * NdotH * (wa2 - 1.0) + 1.0;
            let D = wa2 / (PI * wdenom * wdenom);
            let sunIntensity = lights.directionalLights[li].intensity;
            color = color + lights.directionalLights[li].color * D * sunIntensity * 0.15;
        }
    }

    if (lights.fogEnabled > 0u) {
        color = applyFog(color, input.worldPosition);
    }

    // Reinhard tone-map + gamma
    color = color / (color + vec3<f32>(1.0));
    color = pow(color, vec3<f32>(1.0 / 2.2));

    var result: PBRResult;
    result.color = vec4<f32>(color, alpha);
    result.normal = N;
    return result;
}
`;

export const TERRAIN_FRAGMENT_SHADER = /* wgsl */ `
${TERRAIN_PBR_COMMON}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    let c = computeTerrainPBR(input).color;
    if (c.a < 0.01) { discard; }
    return c;
}
`;

export const TERRAIN_FRAGMENT_SHADER_MRT = /* wgsl */ `
${TERRAIN_PBR_COMMON}

struct MRTOutput {
    @location(0) color: vec4<f32>,
    @location(1) normalDepth: vec4<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> MRTOutput {
    let pbr = computeTerrainPBR(input);
    if (pbr.color.a < 0.01) { discard; }
    var output: MRTOutput;
    output.color = pbr.color;
    let viewPos = camera.viewMatrix * vec4<f32>(input.worldPosition, 1.0);
    let linearDepth = -viewPos.z;
    output.normalDepth = vec4<f32>(pbr.normal, linearDepth);
    return output;
}
`;
