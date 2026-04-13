/**
 * Stores and compiles WGSL shader modules.
 * Contains built-in PBR, post-processing, and debug shaders.
 */
export class ShaderLibrary {
    private device: GPUDevice | null = null;
    private modules = new Map<string, GPUShaderModule>();

    initialize(device: GPUDevice): void {
        this.device = device;
        this.compileModule('pbr_vertex', PBR_VERTEX_SHADER);
        this.compileModule('pbr_vertex_skinned', PBR_VERTEX_SHADER_SKINNED);
        this.compileModule('pbr_fragment', PBR_FRAGMENT_SHADER);
        this.compileModule('pbr_fragment_mrt', PBR_FRAGMENT_SHADER_MRT);
        this.compileModule('building_vertex', BUILDING_VERTEX_SHADER);
        this.compileModule('building_fragment', BUILDING_FRAGMENT_SHADER);
        this.compileModule('building_fragment_mrt', BUILDING_FRAGMENT_SHADER_MRT);
        this.compileModule('shadow_vertex', SHADOW_VERTEX_SHADER);
        this.compileModule('fullscreen_vertex', FULLSCREEN_VERTEX_SHADER);
        this.compileModule('fxaa_fragment', FXAA_FRAGMENT_SHADER);
        this.compileModule('ssr_fragment', SSR_FRAGMENT_SHADER);
        this.compileModule('hbao_fragment', HBAO_FRAGMENT_SHADER);
        this.compileModule('debug_vertex', DEBUG_VERTEX_SHADER);
        this.compileModule('debug_fragment', DEBUG_FRAGMENT_SHADER);
        this.compileModule('skybox_fragment', SKYBOX_FRAGMENT_SHADER);
        this.compileModule('bloom_extract_fragment', BLOOM_EXTRACT_FRAGMENT_SHADER);
        this.compileModule('bloom_blur_fragment', BLOOM_BLUR_FRAGMENT_SHADER);
        this.compileModule('bloom_composite_fragment', BLOOM_COMPOSITE_FRAGMENT_SHADER);
    }

    compileModule(name: string, wgslSource: string): GPUShaderModule {
        if (!this.device) throw new Error('ShaderLibrary not initialized');
        const module = this.device.createShaderModule({ label: name, code: wgslSource });
        this.modules.set(name, module);
        return module;
    }

    getModule(name: string): GPUShaderModule {
        const mod = this.modules.get(name);
        if (!mod) throw new Error(`Shader module "${name}" not found`);
        return mod;
    }

    hasModule(name: string): boolean {
        return this.modules.has(name);
    }

    shutdown(): void {
        this.modules.clear();
        this.device = null;
    }
}

// ============================================================
// Uniform buffer sizes (bytes)
// ============================================================

/** viewMatrix(64) + projMatrix(64) + cameraPosition+pad(16) + cascadeMatrices(4*64=256) + cascadeSplits(16) = 416 */
export const CAMERA_UNIFORM_SIZE = 416;
/** modelMatrix(64) + normalMatrix(64) = 128 */
export const MODEL_UNIFORM_SIZE = 128;
/** Material uniform buffer size */
export const MATERIAL_UNIFORM_SIZE = 64;
/** Light uniform buffer size */
export const LIGHT_UNIFORM_SIZE = 720;

// ============================================================
// Shared WGSL struct definitions
// ============================================================

const CAMERA_STRUCT = /* wgsl */ `
struct CameraUniforms {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    cameraPosition: vec3<f32>,
    _pad0: f32,
    cascadeMatrices: array<mat4x4<f32>, 4>,
    cascadeSplits: vec4<f32>,
};
`;

const MODEL_STRUCT = /* wgsl */ `
struct ModelUniforms {
    modelMatrix: mat4x4<f32>,
    normalMatrix: mat4x4<f32>,
};
`;

// ============================================================
// PBR Vertex Shader
// ============================================================

export const PBR_VERTEX_SHADER = /* wgsl */ `
${CAMERA_STRUCT}
${MODEL_STRUCT}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = model.modelMatrix * vec4<f32>(input.position, 1.0);
    output.worldPosition = worldPos.xyz;
    output.clipPosition = camera.projMatrix * camera.viewMatrix * worldPos;
    let wn = (model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.worldNormal = normalize(wn);
    output.uv = input.uv;
    return output;
}
`;

// ============================================================
// PBR Skinned Vertex Shader (GPU skinning with joint matrices)
// ============================================================

export const PBR_VERTEX_SHADER_SKINNED = /* wgsl */ `
${CAMERA_STRUCT}
${MODEL_STRUCT}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;
@group(1) @binding(1) var<storage, read> jointMatrices: array<mat4x4<f32>>;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) joints: vec4<u32>,
    @location(4) weights: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;

    // Linear blend skinning: weighted sum of joint transforms
    var skinnedPos = vec4<f32>(0.0, 0.0, 0.0, 0.0);
    var skinnedNormal = vec3<f32>(0.0, 0.0, 0.0);

    for (var i = 0u; i < 4u; i = i + 1u) {
        let jointIdx = input.joints[i];
        let weight = input.weights[i];
        if (weight > 0.0) {
            let jm = jointMatrices[jointIdx];
            skinnedPos = skinnedPos + weight * (jm * vec4<f32>(input.position, 1.0));
            skinnedNormal = skinnedNormal + weight * (mat3x3<f32>(jm[0].xyz, jm[1].xyz, jm[2].xyz) * input.normal);
        }
    }

    let worldPos = model.modelMatrix * skinnedPos;
    output.worldPosition = worldPos.xyz;
    output.clipPosition = camera.projMatrix * camera.viewMatrix * worldPos;
    let wn = (model.normalMatrix * vec4<f32>(normalize(skinnedNormal), 0.0)).xyz;
    output.worldNormal = normalize(wn);
    output.uv = input.uv;
    return output;
}
`;

// ============================================================
// PBR Fragment Shader (shared PBR computation)
// ============================================================

const PBR_COMMON = /* wgsl */ `
const PI: f32 = 3.14159265359;

${CAMERA_STRUCT}

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
    /**
     * World-space Y threshold: pixels with worldPosition.y <= waterLevel
     * render as water (Fresnel, waves, sun glints) using the same code
     * path as waterEffect. Set to a large negative value (e.g. -1e20) to
     * disable — any mesh not opting in stays non-water.
     */
    waterLevel: f32,
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

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(2) @binding(0) var<uniform> material: MaterialUniforms;
@group(2) @binding(1) var baseColorTexture: texture_2d<f32>;
@group(2) @binding(2) var baseColorSampler: sampler;
@group(2) @binding(3) var normalMapTexture: texture_2d<f32>;
@group(3) @binding(0) var<uniform> lights: LightUniforms;
@group(3) @binding(1) var shadowMap: texture_depth_2d_array;
@group(3) @binding(2) var shadowSampler: sampler_comparison;

struct FragmentInput {
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
};

struct PBRResult {
    color: vec4<f32>,
    normal: vec3<f32>,
};

fn distributionGGX(N: vec3<f32>, H: vec3<f32>, roughness: f32) -> f32 {
    let a = roughness * roughness;
    let a2 = a * a;
    let NdotH = max(dot(N, H), 0.0);
    let NdotH2 = NdotH * NdotH;
    let denom = (NdotH2 * (a2 - 1.0) + 1.0);
    return a2 / (PI * denom * denom);
}

fn geometrySchlickGGX(NdotV: f32, roughness: f32) -> f32 {
    let r = roughness + 1.0;
    let k = (r * r) / 8.0;
    return NdotV / (NdotV * (1.0 - k) + k);
}

fn geometrySmith(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, roughness: f32) -> f32 {
    let NdotV = max(dot(N, V), 0.0);
    let NdotL = max(dot(N, L), 0.0);
    return geometrySchlickGGX(NdotV, roughness) * geometrySchlickGGX(NdotL, roughness);
}

fn fresnelSchlick(cosTheta: f32, F0: vec3<f32>) -> vec3<f32> {
    return F0 + (1.0 - F0) * pow(clamp(1.0 - cosTheta, 0.0, 1.0), 5.0);
}

fn perturbNormal(N: vec3<f32>, worldPos: vec3<f32>, uv: vec2<f32>, mapN: vec3<f32>) -> vec3<f32> {
    let dp1 = dpdx(worldPos);
    let dp2 = dpdy(worldPos);
    let duv1 = dpdx(uv);
    let duv2 = dpdy(uv);
    let dp2perp = cross(dp2, N);
    let dp1perp = cross(N, dp1);
    let T = dp2perp * duv1.x + dp1perp * duv2.x;
    let B = dp2perp * duv1.y + dp1perp * duv2.y;
    let invmax = inverseSqrt(max(dot(T, T), dot(B, B)));
    let TBN = mat3x3<f32>(T * invmax, B * invmax, N);
    return normalize(TBN * mapN);
}

fn computeDirectLighting(N: vec3<f32>, V: vec3<f32>, L: vec3<f32>, F0: vec3<f32>, albedo: vec3<f32>, metallic: f32, roughness: f32, radiance: vec3<f32>) -> vec3<f32> {
    let H = normalize(V + L);
    let NDF = distributionGGX(N, H, roughness);
    let G = geometrySmith(N, V, L, roughness);
    let F = fresnelSchlick(max(dot(H, V), 0.0), F0);
    let numerator = NDF * G * F;
    let denominator = 4.0 * max(dot(N, V), 0.0) * max(dot(N, L), 0.0) + 0.0001;
    let specular = numerator / denominator;
    let kS = F;
    var kD = vec3<f32>(1.0) - kS;
    kD = kD * (1.0 - metallic);
    let NdotL = max(dot(N, L), 0.0);
    return (kD * albedo / PI + specular) * radiance * NdotL;
}

fn sampleShadowCascade(worldPos: vec3<f32>, normal: vec3<f32>, cascade: i32) -> f32 {
    let lightSpaceMatrix = camera.cascadeMatrices[cascade];
    // Normal offset scales with cascade — further cascades cover bigger
    // extents, so their texels cover more world distance and need more
    // normal bias to avoid self-shadow stippling.
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

    // Distance from the eye along the forward axis selects the cascade.
    let viewPos = camera.viewMatrix * vec4<f32>(worldPos, 1.0);
    let depth = -viewPos.z;

    var cascade = 0;
    if (depth > camera.cascadeSplits.x) { cascade = 1; }
    if (depth > camera.cascadeSplits.y) { cascade = 2; }
    if (depth > camera.cascadeSplits.z) { cascade = 3; }
    if (depth > camera.cascadeSplits.w) { return 1.0; }

    let shadow = sampleShadowCascade(worldPos, normal, cascade);

    // Smooth transition at cascade boundaries to avoid visible seams.
    let cascadeFar = camera.cascadeSplits[cascade];
    let cascadeNear = select(camera.cascadeSplits[cascade - 1], 0.0, cascade == 0);
    let blendZone = (cascadeFar - cascadeNear) * 0.1;
    let distToEdge = cascadeFar - depth;
    if (distToEdge < blendZone && cascade < 3) {
        let nextShadow = sampleShadowCascade(worldPos, normal, cascade + 1);
        return mix(nextShadow, shadow, distToEdge / blendZone);
    }
    return shadow;
}

fn pointLightAttenuation(distance: f32, range: f32) -> f32 {
    let d2 = distance * distance;
    let r2 = range * range;
    let attn = clamp(1.0 - d2 * d2 / (r2 * r2), 0.0, 1.0);
    return attn * attn / (d2 + 1.0);
}

fn applyFog(color: vec3<f32>, worldPos: vec3<f32>) -> vec3<f32> {
    let dist = distance(camera.cameraPosition, worldPos);
    let fogFactor = clamp((lights.fogFar - dist) / (lights.fogFar - lights.fogNear), 0.0, 1.0);
    return mix(lights.fogColor, color, fogFactor);
}

fn computePBR(input: FragmentInput) -> PBRResult {
    var albedo = material.baseColor.rgb;
    var alpha = material.baseColor.a;
    if (material.hasBaseColorTexture > 0u) {
        let scaledUV = input.uv * vec2<f32>(material.uvScaleX, material.uvScaleY);
        let texColor = textureSample(baseColorTexture, baseColorSampler, scaledUV);
        albedo = texColor.rgb * material.baseColor.rgb;
        alpha = texColor.a * material.baseColor.a;
    }
    var metallic = material.metallic;
    var roughness = max(material.roughness, 0.04);
    var N = normalize(input.worldNormal);

    // Normal mapping via screen-space derivatives (cotangent frame)
    if (material.hasNormalMap > 0u) {
        let scaledUVN = input.uv * vec2<f32>(material.uvScaleX, material.uvScaleY);
        var mapN = textureSample(normalMapTexture, baseColorSampler, scaledUVN).xyz * 2.0 - 1.0;
        mapN.x = mapN.x * material.normalScale;
        mapN.y = mapN.y * material.normalScale;
        N = perturbNormal(N, input.worldPosition, input.uv, mapN);
    }

    // Water: opt-in via the waterEffect flag (whole mesh is water) or
    // per-pixel when worldPosition.y drops below waterLevel (for meshes
    // like terrain where only some pixels are underwater).
    let isWater = material.waterEffect > 0u || input.worldPosition.y <= material.waterLevel;

    // Water effect: multi-octave directional waves, depth color, subsurface scattering
    if (isWater) {
        let t = lights.time;
        let wp = input.worldPosition;
        let camDist = distance(camera.cameraPosition, wp);

        // 8-octave directional waves with distance-based LOD fade
        var waveNx = 0.0;
        var waveNz = 0.0;
        // Octave 1: broad ocean swell
        waveNx += cos(wp.x * 0.8 + wp.z * 0.3 + t * 0.9) * 0.28;
        waveNz += cos(wp.z * 1.0 - wp.x * 0.2 + t * 0.7) * 0.26;
        // Octave 2: medium waves
        waveNx += cos(wp.x * 1.8 - wp.z * 0.6 + t * 1.4) * 0.17;
        waveNz += cos(wp.z * 2.2 + wp.x * 0.4 + t * 1.6) * 0.15;
        // Octave 3: chop
        waveNx += cos(wp.x * 3.5 + wp.z * 1.5 + t * 2.5) * 0.09;
        waveNz += cos(wp.z * 4.0 - wp.x * 1.2 + t * 2.8) * 0.08;
        // Octave 4: small waves
        waveNx += cos(wp.x * 7.0 - wp.z * 3.0 + t * 3.8) * 0.045;
        waveNz += cos(wp.z * 8.5 + wp.x * 2.5 + t * 4.2) * 0.04;
        // Octave 5: ripples (fade with distance)
        let lod5 = clamp(1.0 - camDist / 200.0, 0.0, 1.0);
        waveNx += cos(wp.x * 15.0 + wp.z * 7.0 + t * 5.5) * 0.025 * lod5;
        waveNz += cos(wp.z * 17.0 - wp.x * 6.0 + t * 6.0) * 0.022 * lod5;
        // Octave 6: fine ripples
        let lod6 = clamp(1.0 - camDist / 120.0, 0.0, 1.0);
        waveNx += cos(wp.x * 30.0 - wp.z * 12.0 + t * 7.5) * 0.015 * lod6;
        waveNz += cos(wp.z * 35.0 + wp.x * 10.0 + t * 8.2) * 0.013 * lod6;
        // Octave 7: micro ripples
        let lod7 = clamp(1.0 - camDist / 60.0, 0.0, 1.0);
        waveNx += cos(wp.x * 60.0 + wp.z * 25.0 + t * 10.0) * 0.008 * lod7;
        waveNz += cos(wp.z * 70.0 - wp.x * 20.0 + t * 11.5) * 0.007 * lod7;
        // Octave 8: ultra-fine shimmer (closest only)
        let lod8 = clamp(1.0 - camDist / 30.0, 0.0, 1.0);
        waveNx += cos(wp.x * 120.0 - wp.z * 50.0 + t * 14.0) * 0.004 * lod8;
        waveNz += cos(wp.z * 140.0 + wp.x * 45.0 + t * 16.0) * 0.0035 * lod8;

        N = normalize(vec3<f32>(waveNx, 1.0, waveNz));

        // Depth-based color: deep blue core, lighter turquoise at shallow/grazing angles
        let deepColor = vec3<f32>(0.02, 0.08, 0.18);
        let shallowColor = vec3<f32>(0.05, 0.35, 0.45);
        let viewDot = max(dot(normalize(vec3<f32>(0.0, 1.0, 0.0)), normalize(camera.cameraPosition - wp)), 0.0);
        let depthBlend = pow(1.0 - viewDot, 2.0);
        albedo = mix(deepColor, shallowColor, depthBlend);

        // Subsurface scattering: light bleeding through wave crests
        let waveHeight = (waveNx + waveNz) * 0.5 + 0.5;
        let sssColor = vec3<f32>(0.08, 0.45, 0.35);
        albedo = albedo + sssColor * pow(waveHeight, 3.0) * 0.25;

        // Foam at steep wave peaks
        let steepness = 1.0 - N.y;
        let foamThreshold = 0.12;
        let foam = smoothstep(foamThreshold, foamThreshold + 0.08, steepness);
        albedo = mix(albedo, vec3<f32>(0.85, 0.9, 0.95), foam * 0.7);

        alpha = mix(0.75, 0.95, depthBlend);
        roughness = mix(0.05, 0.3, foam);
        metallic = 0.0;
    }

    let V = normalize(camera.cameraPosition - input.worldPosition);
    let F0 = mix(vec3<f32>(0.04), albedo, metallic);

    var Lo = vec3<f32>(0.0);
    let shadowFactor = computeShadow(input.worldPosition, N);

    // Directional lights
    let numDirLights = min(lights.numDirectionalLights, 4u);
    for (var i = 0u; i < numDirLights; i = i + 1u) {
        let light = lights.directionalLights[i];
        let L = normalize(-light.direction);
        let radiance = light.color * light.intensity;
        // Apply shadow only to first (main) directional light
        let sf = select(1.0, shadowFactor, i == 0u);
        Lo = Lo + computeDirectLighting(N, V, L, F0, albedo, metallic, roughness, radiance) * sf;
    }

    // Point lights
    let numPtLights = min(lights.numPointLights, 8u);
    for (var i = 0u; i < numPtLights; i = i + 1u) {
        let light = lights.pointLights[i];
        let lightVec = light.position - input.worldPosition;
        let dist = length(lightVec);
        let L = normalize(lightVec);
        let attn = pointLightAttenuation(dist, light.range);
        let radiance = light.color * light.intensity * attn;
        Lo = Lo + computeDirectLighting(N, V, L, F0, albedo, metallic, roughness, radiance);
    }

    // Spot lights
    let numSpLights = min(lights.numSpotLights, 4u);
    for (var i = 0u; i < numSpLights; i = i + 1u) {
        let light = lights.spotLights[i];
        let lightVec = light.position - input.worldPosition;
        let dist = length(lightVec);
        let L = normalize(lightVec);
        let attn = pointLightAttenuation(dist, light.range);
        let theta = dot(L, normalize(-light.direction));
        let epsilon = light.innerCone - light.outerCone;
        let spotFactor = clamp((theta - light.outerCone) / max(epsilon, 0.001), 0.0, 1.0);
        let radiance = light.color * light.intensity * attn * spotFactor;
        Lo = Lo + computeDirectLighting(N, V, L, F0, albedo, metallic, roughness, radiance);
    }

    let ambient = lights.ambientColor * lights.ambientIntensity * albedo;
    var color = ambient + Lo + material.emissive;

    // Water: Schlick Fresnel with water IOR + sun specular glints + sky reflection
    if (isWater) {
        // Schlick Fresnel with IOR 1.33 (water) -> F0 ~ 0.02
        let NdotV = max(dot(N, V), 0.0);
        let F0_water = vec3<f32>(0.02);
        let fresnel = F0_water + (vec3<f32>(1.0) - F0_water) * pow(1.0 - NdotV, 5.0);

        // Sky reflection gradient (horizon darker, zenith lighter)
        let reflectDir = reflect(-V, N);
        let skyUp = max(reflectDir.y, 0.0);
        let skyHorizon = vec3<f32>(0.55, 0.7, 0.85);
        let skyZenith = vec3<f32>(0.25, 0.45, 0.75);
        let skyColor = mix(skyHorizon, skyZenith, skyUp);
        color = mix(color, skyColor, fresnel);

        // Sun specular glints: tight highlight on the water surface
        let numDL = min(lights.numDirectionalLights, 1u);
        for (var li = 0u; li < numDL; li = li + 1u) {
            let sunDir = normalize(-lights.directionalLights[li].direction);
            let H = normalize(V + sunDir);
            let NdotH = max(dot(N, H), 0.0);
            let glint = pow(NdotH, 512.0) * lights.directionalLights[li].intensity * 2.0;
            color = color + lights.directionalLights[li].color * glint;
        }
    }

    // Fog (applied before tone mapping since it's a physical phenomenon)
    if (lights.fogEnabled > 0u) {
        color = applyFog(color, input.worldPosition);
    }

    // Reinhard tone mapping
    color = color / (color + vec3<f32>(1.0));
    // Gamma correction
    color = pow(color, vec3<f32>(1.0 / 2.2));

    var result: PBRResult;
    result.color = vec4<f32>(color, alpha);
    result.normal = N;
    return result;
}
`;

export const PBR_FRAGMENT_SHADER = /* wgsl */ `
${PBR_COMMON}

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    let c = computePBR(input).color;
    if (c.a < 0.01) { discard; }
    return c;
}
`;

export const PBR_FRAGMENT_SHADER_MRT = /* wgsl */ `
${PBR_COMMON}

struct MRTOutput {
    @location(0) color: vec4<f32>,
    @location(1) normalDepth: vec4<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> MRTOutput {
    let pbr = computePBR(input);
    if (pbr.color.a < 0.01) { discard; }
    var output: MRTOutput;
    output.color = pbr.color;
    let viewPos = camera.viewMatrix * vec4<f32>(input.worldPosition, 1.0);
    let linearDepth = -viewPos.z;
    output.normalDepth = vec4<f32>(pbr.normal, linearDepth);
    return output;
}
`;

// ============================================================
// Building Vertex Shader — adds per-vertex buildingMeta (u32)
// ============================================================

export const BUILDING_VERTEX_SHADER = /* wgsl */ `
${CAMERA_STRUCT}
${MODEL_STRUCT}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<uniform> model: ModelUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) normal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) buildingMeta: u32,
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) @interpolate(flat) buildingMeta: u32,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    let worldPos = model.modelMatrix * vec4<f32>(input.position, 1.0);
    output.worldPosition = worldPos.xyz;
    output.clipPosition = camera.projMatrix * camera.viewMatrix * worldPos;
    let wn = (model.normalMatrix * vec4<f32>(input.normal, 0.0)).xyz;
    output.worldNormal = normalize(wn);
    output.uv = input.uv;
    output.buildingMeta = input.buildingMeta;
    return output;
}
`;

// ============================================================
// Building Fragment Shader — plain PBR with procedural window grid
// ============================================================
//
// buildingMeta u32: bits [0:7] hold the wall segment width in 0.25 m
// units (0..63.75 m). `0` is the "no window grid" sentinel — used on
// roof vertices so the shader falls through to plain PBR there.
//
// UVs are in meters: uv.x ∈ [0, wallWidth], uv.y ∈ [0, buildingHeight].
// Window grid: 0.5 m edge margins, ~2.5 m column spacing snapped to fit
// the segment, 3.5 m floor height, ~60% pane coverage per cell,
// skipped below 1.7 m to clear the ground floor (the extrusion sinks
// walls 0.5 m into the terrain, so 1.7 m of uv.y ≈ 1.2 m of real wall).

const BUILDING_COMMON = /* wgsl */ `
${PBR_COMMON}

fn buildingWindowMask(uv: vec2<f32>, metaBits: u32) -> f32 {
    let wallWidth = f32(metaBits & 0xFFu) * 0.25;
    if (wallWidth < 0.1) { return 0.0; }
    if (uv.y < 1.7) { return 0.0; }

    let edgeMargin = 0.5;
    let usable = max(wallWidth - edgeMargin * 2.0, 0.0);
    if (usable < 1.5) { return 0.0; }

    let facadeU = uv.x - edgeMargin;
    if (facadeU < 0.0 || facadeU > usable) { return 0.0; }

    let numCols = max(round(usable / 2.5), 1.0);
    let colSpacing = usable / numCols;

    let winU = fract(facadeU / colSpacing);
    let winV = fract((uv.y - 0.5) / 3.5);

    // Centered pane, ~60% of the cell in both axes with softened edges.
    let dU = abs(winU - 0.5);
    let dV = abs(winV - 0.5);
    let mU = 1.0 - smoothstep(0.28, 0.32, dU);
    let mV = 1.0 - smoothstep(0.32, 0.36, dV);
    return mU * mV;
}
`;

// Dark glass with a small emissive lift so windows still read at dusk
// without turning cartoonish at noon. Inlined at the call site below.
const BUILDING_WINDOW_COLOR = 'vec3<f32>(0.08, 0.12, 0.19)';

export const BUILDING_FRAGMENT_SHADER = /* wgsl */ `
${BUILDING_COMMON}

struct BuildingFragmentInput {
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) @interpolate(flat) buildingMeta: u32,
};

@fragment
fn fs_main(input: BuildingFragmentInput) -> @location(0) vec4<f32> {
    var pbrInput: FragmentInput;
    pbrInput.worldPosition = input.worldPosition;
    pbrInput.worldNormal = input.worldNormal;
    pbrInput.uv = input.uv;
    let pbr = computePBR(pbrInput);
    if (pbr.color.a < 0.01) { discard; }
    let mask = buildingWindowMask(input.uv, input.buildingMeta);
    let rgb = mix(pbr.color.rgb, ${BUILDING_WINDOW_COLOR}, mask);
    return vec4<f32>(rgb, pbr.color.a);
}
`;

export const BUILDING_FRAGMENT_SHADER_MRT = /* wgsl */ `
${BUILDING_COMMON}

struct BuildingFragmentInput {
    @location(0) worldPosition: vec3<f32>,
    @location(1) worldNormal: vec3<f32>,
    @location(2) uv: vec2<f32>,
    @location(3) @interpolate(flat) buildingMeta: u32,
};

struct MRTOutput {
    @location(0) color: vec4<f32>,
    @location(1) normalDepth: vec4<f32>,
};

@fragment
fn fs_main(input: BuildingFragmentInput) -> MRTOutput {
    var pbrInput: FragmentInput;
    pbrInput.worldPosition = input.worldPosition;
    pbrInput.worldNormal = input.worldNormal;
    pbrInput.uv = input.uv;
    let pbr = computePBR(pbrInput);
    if (pbr.color.a < 0.01) { discard; }
    let mask = buildingWindowMask(input.uv, input.buildingMeta);
    let rgb = mix(pbr.color.rgb, ${BUILDING_WINDOW_COLOR}, mask);
    let viewPos = camera.viewMatrix * vec4<f32>(input.worldPosition, 1.0);
    var output: MRTOutput;
    output.color = vec4<f32>(rgb, pbr.color.a);
    output.normalDepth = vec4<f32>(pbr.normal, -viewPos.z);
    return output;
}
`;

// ============================================================
// Shadow Vertex Shader
// ============================================================

export const SHADOW_VERTEX_SHADER = /* wgsl */ `
struct LightCamera {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
};
${MODEL_STRUCT}

@group(0) @binding(0) var<uniform> lightCamera: LightCamera;
@group(1) @binding(0) var<uniform> model: ModelUniforms;

@vertex
fn vs_main(@location(0) position: vec3<f32>) -> @builtin(position) vec4<f32> {
    return lightCamera.projMatrix * lightCamera.viewMatrix * model.modelMatrix * vec4<f32>(position, 1.0);
}
`;

// ============================================================
// Fullscreen Vertex Shader (for post-processing)
// ============================================================

export const FULLSCREEN_VERTEX_SHADER = /* wgsl */ `
struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    // Full-screen triangle
    var pos = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>(3.0, -1.0),
        vec2<f32>(-1.0, 3.0)
    );
    var output: VertexOutput;
    let p = pos[vertexIndex];
    output.position = vec4<f32>(p, 0.0, 1.0);
    output.uv = vec2<f32>((p.x + 1.0) * 0.5, 1.0 - (p.y + 1.0) * 0.5);
    return output;
}
`;

// ============================================================
// FXAA Fragment Shader
// ============================================================

export const FXAA_FRAGMENT_SHADER = /* wgsl */ `
@group(0) @binding(0) var inputTexture: texture_2d<f32>;
@group(0) @binding(1) var inputSampler: sampler;

struct FXAAParams {
    viewportSize: vec2<f32>,
    _pad: vec2<f32>,
};
@group(0) @binding(2) var<uniform> params: FXAAParams;

fn luma(c: vec3<f32>) -> f32 {
    return dot(c, vec3<f32>(0.299, 0.587, 0.114));
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let rcpFrame = 1.0 / params.viewportSize;

    let rgbM = textureSample(inputTexture, inputSampler, uv).rgb;
    let rgbNW = textureSample(inputTexture, inputSampler, uv + vec2<f32>(-1.0, -1.0) * rcpFrame).rgb;
    let rgbNE = textureSample(inputTexture, inputSampler, uv + vec2<f32>(1.0, -1.0) * rcpFrame).rgb;
    let rgbSW = textureSample(inputTexture, inputSampler, uv + vec2<f32>(-1.0, 1.0) * rcpFrame).rgb;
    let rgbSE = textureSample(inputTexture, inputSampler, uv + vec2<f32>(1.0, 1.0) * rcpFrame).rgb;

    let lumM = luma(rgbM);
    let lumNW = luma(rgbNW);
    let lumNE = luma(rgbNE);
    let lumSW = luma(rgbSW);
    let lumSE = luma(rgbSE);

    let lumMin = min(lumM, min(min(lumNW, lumNE), min(lumSW, lumSE)));
    let lumMax = max(lumM, max(max(lumNW, lumNE), max(lumSW, lumSE)));
    let lumRange = lumMax - lumMin;

    var dir: vec2<f32>;
    dir.x = -((lumNW + lumNE) - (lumSW + lumSE));
    dir.y = ((lumNW + lumSW) - (lumNE + lumSE));

    let dirReduce = max((lumNW + lumNE + lumSW + lumSE) * 0.0625, 1.0 / 128.0);
    let rcpDirMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + dirReduce);
    dir = clamp(dir * rcpDirMin, vec2<f32>(-8.0), vec2<f32>(8.0)) * rcpFrame;

    // All texture samples must happen in uniform control flow
    let rgbA = 0.5 * (
        textureSample(inputTexture, inputSampler, uv + dir * (1.0 / 3.0 - 0.5)).rgb +
        textureSample(inputTexture, inputSampler, uv + dir * (2.0 / 3.0 - 0.5)).rgb
    );
    let rgbB = rgbA * 0.5 + 0.25 * (
        textureSample(inputTexture, inputSampler, uv + dir * -0.5).rgb +
        textureSample(inputTexture, inputSampler, uv + dir * 0.5).rgb
    );
    let lumB = luma(rgbB);

    // Use select instead of branches to maintain uniform control flow
    let noEdge = lumRange < max(0.0312, lumMax * 0.125);
    let bOutOfRange = lumB < lumMin || lumB > lumMax;
    var result = rgbB;
    result = select(result, rgbA, bOutOfRange);
    result = select(result, rgbM, noEdge);
    return vec4<f32>(result, 1.0);
}
`;

// ============================================================
// SSR Fragment Shader
// ============================================================

export const SSR_FRAGMENT_SHADER = /* wgsl */ `
struct SSRParams {
    projMatrix: mat4x4<f32>,
    viewMatrix: mat4x4<f32>,
    invProjMatrix: mat4x4<f32>,
    viewportSize: vec2<f32>,
    nearPlane: f32,
    farPlane: f32,
};

@group(0) @binding(0) var<uniform> params: SSRParams;
@group(0) @binding(1) var colorTexture: texture_2d<f32>;
@group(0) @binding(2) var normalDepthTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // All textureSample calls must be in uniform control flow, so sample upfront
    let color = textureSample(colorTexture, texSampler, uv);
    let nd = textureSample(normalDepthTexture, texSampler, uv);

    let worldNormal = nd.xyz;
    let linearDepth = nd.w;
    let N = normalize(worldNormal);

    // Reconstruct view-space position from depth
    let ndcX = uv.x * 2.0 - 1.0;
    let ndcY = (1.0 - uv.y) * 2.0 - 1.0;
    let clipPos = vec4<f32>(ndcX, ndcY, 0.5, 1.0);
    let viewPos4 = params.invProjMatrix * clipPos;
    var viewDir = normalize(viewPos4.xyz / viewPos4.w);
    viewDir = viewDir * (linearDepth / -viewDir.z);

    let viewNormal = normalize((params.viewMatrix * vec4<f32>(N, 0.0)).xyz);
    let reflectDir = reflect(normalize(viewDir), viewNormal);

    // Skip conditions (no geometry, or reflection pointing away)
    let skip = linearDepth <= 0.001 || length(worldNormal) < 0.5 || reflectDir.z > 0.1;

    // Ray march -- use textureLoad instead of textureSample to avoid uniform control flow issues
    let stepSize = 0.3;
    var hitUV = vec2<f32>(0.0);
    var hitStrength = 0.0;

    let texSize = vec2<f32>(textureDimensions(colorTexture, 0));

    for (var i = 1; i <= 24; i++) {
        let rayPos = viewDir + reflectDir * (f32(i) * stepSize);

        let projPos = params.projMatrix * vec4<f32>(rayPos, 1.0);
        let screenNDC = projPos.xy / projPos.w;
        let screenUV = vec2<f32>(screenNDC.x * 0.5 + 0.5, 1.0 - (screenNDC.y * 0.5 + 0.5));

        let inBounds = screenUV.x >= 0.0 && screenUV.x <= 1.0 && screenUV.y >= 0.0 && screenUV.y <= 1.0;
        let texCoord = vec2<i32>(vec2<f32>(screenUV.x, screenUV.y) * texSize);
        let sampleND = textureLoad(normalDepthTexture, texCoord, 0);
        let sampleDepth = sampleND.w;
        let rayDepth = -rayPos.z;

        let isHit = inBounds && sampleDepth > 0.0 && rayDepth > sampleDepth && rayDepth - sampleDepth < stepSize * 2.0;
        let edgeFade = 1.0 - pow(max(abs(screenNDC.x), abs(screenNDC.y)), 4.0);

        // Only accept the first hit
        if (isHit && hitStrength == 0.0) {
            hitUV = screenUV;
            hitStrength = clamp(edgeFade, 0.0, 1.0);
        }
    }

    // Sample hit color with a 3x3 Gaussian blur (step=2px) to soften reflections
    let hitTexCoord = vec2<i32>(hitUV * texSize);
    let bStep = 2;
    var blurred = textureLoad(colorTexture, hitTexCoord, 0) * 4.0;
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>(-bStep, 0), 0) * 2.0;
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>( bStep, 0), 0) * 2.0;
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>(0, -bStep), 0) * 2.0;
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>(0,  bStep), 0) * 2.0;
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>(-bStep, -bStep), 0);
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>( bStep, -bStep), 0);
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>(-bStep,  bStep), 0);
    blurred += textureLoad(colorTexture, hitTexCoord + vec2<i32>( bStep,  bStep), 0);
    let hitColor = blurred / 16.0;

    let VdotN = max(dot(-normalize(viewDir), viewNormal), 0.0);
    let fresnel = pow(1.0 - VdotN, 3.0) * 0.4;
    let blendFactor = select(fresnel * hitStrength, 0.0, skip);

    return mix(color, hitColor, blendFactor);
}
`;

// ============================================================
// HBAO Fragment Shader
// ============================================================

export const HBAO_FRAGMENT_SHADER = /* wgsl */ `
struct HBAOParams {
    viewMatrix: mat4x4<f32>,
    projMatrix: mat4x4<f32>,
    invProjMatrix: mat4x4<f32>,
    viewportSize: vec2<f32>,
    nearPlane: f32,
    farPlane: f32,
    aoRadius: f32,
    aoStrength: f32,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> params: HBAOParams;
@group(0) @binding(1) var colorTexture: texture_2d<f32>;
@group(0) @binding(2) var depthTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

const DIRECTIONS: i32 = 6;
const STEPS: i32 = 4;
const PI: f32 = 3.14159265359;

fn getLinearDepth(uv: vec2<f32>) -> f32 {
    let texSize = vec2<i32>(textureDimensions(depthTexture, 0));
    let coord = vec2<i32>(uv * vec2<f32>(texSize));
    let d = textureLoad(depthTexture, coord, 0).w;
    return d;
}

fn getViewPos(uv: vec2<f32>, depth: f32) -> vec3<f32> {
    let ndcX = uv.x * 2.0 - 1.0;
    let ndcY = (1.0 - uv.y) * 2.0 - 1.0;
    let clip = vec4<f32>(ndcX, ndcY, 0.5, 1.0);
    let viewPos = params.invProjMatrix * clip;
    let viewDir = normalize(viewPos.xyz / viewPos.w);
    // depth is view-space Z distance (-viewPos.z), scale ray to match
    return viewDir * (depth / -viewDir.z);
}

fn hash(p: vec2<f32>) -> f32 {
    var p3 = fract(vec3<f32>(p.x, p.y, p.x) * 0.1031);
    p3 = p3 + dot(p3, vec3<f32>(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
    return fract((p3.x + p3.y) * p3.z);
}

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let color = textureSample(colorTexture, texSampler, uv);
    let centerDepth = getLinearDepth(uv);

    // Skip sky / far pixels
    if (centerDepth <= 0.001 || centerDepth > params.farPlane * 0.99) {
        return color;
    }

    let centerPos = getViewPos(uv, centerDepth);
    let pixelSize = 1.0 / params.viewportSize;

    // Read world-space normal from texture and transform to view space
    let texSize = vec2<i32>(textureDimensions(depthTexture, 0));
    let centerCoord = vec2<i32>(uv * vec2<f32>(texSize));
    let worldNormal = normalize(textureLoad(depthTexture, centerCoord, 0).xyz);
    let viewNormal = normalize((params.viewMatrix * vec4<f32>(worldNormal, 0.0)).xyz);

    let radiusPixels = params.aoRadius * params.viewportSize.y / centerDepth;
    let clampedRadius = clamp(radiusPixels, 3.0, 48.0);

    let randomAngle = hash(uv * params.viewportSize) * 2.0 * PI;

    var occlusion = 0.0;
    var totalWeight = 0.0;

    for (var d = 0; d < DIRECTIONS; d++) {
        let angle = (f32(d) / f32(DIRECTIONS)) * 2.0 * PI + randomAngle;
        let dir = vec2<f32>(cos(angle), sin(angle));

        for (var s = 1; s <= STEPS; s++) {
            let stepOffset = dir * (f32(s) / f32(STEPS)) * clampedRadius * pixelSize;
            let sampleUV = uv + stepOffset;

            if (sampleUV.x < 0.0 || sampleUV.x > 1.0 || sampleUV.y < 0.0 || sampleUV.y > 1.0) {
                continue;
            }

            let sampleDepth = getLinearDepth(sampleUV);
            if (sampleDepth <= 0.001) { continue; }

            let samplePos = getViewPos(sampleUV, sampleDepth);
            let diff = samplePos - centerPos;
            let dist = length(diff);

            if (dist < 0.001) { continue; }

            let diffNorm = diff / dist;

            // Only count occlusion from samples above the tangent plane
            let normalDot = dot(diffNorm, viewNormal);

            // Range check: reject samples from different surfaces (prevents edge halos)
            let rangeCheck = 1.0 - smoothstep(params.aoRadius * 0.5, params.aoRadius * 2.0, dist);

            // Bias of 0.1 to prevent self-occlusion on flat surfaces
            occlusion += max(normalDot - 0.1, 0.0) * rangeCheck;
            totalWeight += 1.0;
        }
    }

    occlusion = occlusion / max(totalWeight, 1.0);
    let ao = 1.0 - occlusion * params.aoStrength;
    let finalAO = clamp(ao, 0.0, 1.0);

    return vec4<f32>(color.rgb * finalAO, color.a);
}
`;

// ============================================================
// Skybox Fragment Shader (procedural sky with day/night cycle)
// ============================================================

export const SKYBOX_FRAGMENT_SHADER = /* wgsl */ `
struct SkyboxParams {
    invViewProjMatrix: mat4x4<f32>,
    sunDirection: vec3<f32>,
    sunElevation: f32,
};

@group(0) @binding(0) var<uniform> params: SkyboxParams;
@group(0) @binding(1) var colorTexture: texture_2d<f32>;
@group(0) @binding(2) var normalDepthTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

const PI: f32 = 3.14159265359;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // Sample color upfront (uniform control flow)
    let color = textureSample(colorTexture, texSampler, uv);

    // Check if there's geometry at this pixel
    let texSize = vec2<i32>(textureDimensions(normalDepthTexture, 0));
    let coord = vec2<i32>(uv * vec2<f32>(texSize));
    let nd = textureLoad(normalDepthTexture, coord, 0);
    let linearDepth = nd.w;

    // If geometry exists, keep existing color
    if (linearDepth > 0.001) {
        return color;
    }

    // Reconstruct world-space ray direction from UV
    let ndcX = uv.x * 2.0 - 1.0;
    let ndcY = (1.0 - uv.y) * 2.0 - 1.0;
    let clipNear = vec4<f32>(ndcX, ndcY, 0.0, 1.0);
    let clipFar = vec4<f32>(ndcX, ndcY, 1.0, 1.0);
    let worldNear = params.invViewProjMatrix * clipNear;
    let worldFar = params.invViewProjMatrix * clipFar;
    let rayDir = normalize(worldFar.xyz / worldFar.w - worldNear.xyz / worldNear.w);

    let sunDir = normalize(params.sunDirection);
    let elev = params.sunElevation; // -1 to 1, where 0 = horizon

    // Sky color palette that varies with sun elevation
    // Day colors
    let dayHorizon = vec3<f32>(0.7, 0.8, 0.95);
    let dayZenith = vec3<f32>(0.25, 0.45, 0.85);
    // Sunset colors
    let sunsetHorizon = vec3<f32>(0.95, 0.55, 0.25);
    let sunsetZenith = vec3<f32>(0.35, 0.3, 0.6);
    // Night colors
    let nightHorizon = vec3<f32>(0.06, 0.06, 0.12);
    let nightZenith = vec3<f32>(0.02, 0.02, 0.06);

    // Blend factors based on sun elevation
    let dayFactor = clamp(elev * 4.0, 0.0, 1.0);
    let sunsetFactor = clamp(1.0 - abs(elev) * 6.0, 0.0, 1.0);
    let nightFactor = clamp(-elev * 4.0, 0.0, 1.0);
    let totalFactor = dayFactor + sunsetFactor + nightFactor + 0.001;

    let horizonColor = (dayHorizon * dayFactor + sunsetHorizon * sunsetFactor + nightHorizon * nightFactor) / totalFactor;
    let zenithColor = (dayZenith * dayFactor + sunsetZenith * sunsetFactor + nightZenith * nightFactor) / totalFactor;

    // Ground color (below horizon)
    let groundColor = vec3<f32>(0.25, 0.22, 0.18) * max(dayFactor + sunsetFactor * 0.5, 0.1);

    // Sky gradient
    let up = rayDir.y;
    var skyColor: vec3<f32>;
    if (up > 0.0) {
        skyColor = mix(horizonColor, zenithColor, pow(up, 0.4));
    } else {
        skyColor = mix(horizonColor, groundColor, pow(-up, 0.7));
    }

    // Sun disc
    let sunDot = dot(rayDir, sunDir);
    let sunVisible = max(elev + 0.1, 0.0); // fade sun near horizon
    if (sunDot > 0.9995) {
        skyColor = skyColor + vec3<f32>(10.0, 9.0, 7.0) * sunVisible;
    } else if (sunDot > 0.998) {
        let t = (sunDot - 0.998) / (0.9995 - 0.998);
        skyColor = skyColor + vec3<f32>(6.0, 5.0, 3.5) * t * t * sunVisible;
    }

    // Sun glow
    let sunGlow = max(sunDot, 0.0);
    let glowColor = mix(vec3<f32>(1.0, 0.4, 0.1), vec3<f32>(1.0, 0.7, 0.4), dayFactor);
    skyColor = skyColor + glowColor * pow(sunGlow, 8.0) * 0.5 * sunVisible;

    // Stars at night
    if (nightFactor > 0.1) {
        // Simple star field using hash
        let starUV = rayDir.xz / (abs(rayDir.y) + 0.001) * 50.0;
        let starHash = fract(sin(dot(floor(starUV), vec2<f32>(127.1, 311.7))) * 43758.5453);
        let starBright = step(0.995, starHash) * nightFactor * max(up, 0.0);
        skyColor = skyColor + vec3<f32>(starBright);
    }

    // Tone mapping + gamma
    skyColor = skyColor / (skyColor + vec3<f32>(1.0));
    skyColor = pow(skyColor, vec3<f32>(1.0 / 2.2));

    return vec4<f32>(skyColor, 1.0);
}
`;

// ============================================================
// Bloom Extract Fragment Shader
// ============================================================

export const BLOOM_EXTRACT_FRAGMENT_SHADER = /* wgsl */ `
struct BloomExtractParams {
    threshold: f32,
    softThreshold: f32,
    _pad: vec2<f32>,
};

@group(0) @binding(0) var<uniform> params: BloomExtractParams;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let color = textureSample(inputTexture, texSampler, uv);
    let brightness = dot(color.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    let soft = brightness - params.threshold + params.softThreshold;
    let contribution = max(soft, 0.0) / max(brightness, 0.0001);
    let knee = clamp(contribution, 0.0, 1.0);
    return vec4<f32>(color.rgb * knee, 1.0);
}
`;

// ============================================================
// Bloom Blur Fragment Shader (separable Gaussian)
// ============================================================

export const BLOOM_BLUR_FRAGMENT_SHADER = /* wgsl */ `
struct BloomBlurParams {
    direction: vec2<f32>,
    texelSize: vec2<f32>,
};

@group(0) @binding(0) var<uniform> params: BloomBlurParams;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var texSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    // 9-tap Gaussian blur (compile-time unrolled)
    let dir = params.direction * params.texelSize;

    var result = textureSample(inputTexture, texSampler, uv) * 0.2270;
    result += textureSample(inputTexture, texSampler, uv + dir * 1.0) * 0.1945;
    result += textureSample(inputTexture, texSampler, uv - dir * 1.0) * 0.1945;
    result += textureSample(inputTexture, texSampler, uv + dir * 2.0) * 0.1216;
    result += textureSample(inputTexture, texSampler, uv - dir * 2.0) * 0.1216;
    result += textureSample(inputTexture, texSampler, uv + dir * 3.0) * 0.0540;
    result += textureSample(inputTexture, texSampler, uv - dir * 3.0) * 0.0540;
    result += textureSample(inputTexture, texSampler, uv + dir * 4.0) * 0.0162;
    result += textureSample(inputTexture, texSampler, uv - dir * 4.0) * 0.0162;

    return result;
}
`;

// ============================================================
// Bloom Composite Fragment Shader
// ============================================================

export const BLOOM_COMPOSITE_FRAGMENT_SHADER = /* wgsl */ `
struct BloomCompositeParams {
    bloomIntensity: f32,
    _pad0: f32,
    _pad1: f32,
    _pad2: f32,
};

@group(0) @binding(0) var<uniform> params: BloomCompositeParams;
@group(0) @binding(1) var sceneTexture: texture_2d<f32>;
@group(0) @binding(2) var bloomTexture: texture_2d<f32>;
@group(0) @binding(3) var texSampler: sampler;

@fragment
fn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {
    let scene = textureSample(sceneTexture, texSampler, uv);
    let bloom = textureSample(bloomTexture, texSampler, uv);
    return vec4<f32>(scene.rgb + bloom.rgb * params.bloomIntensity, scene.a);
}
`;

// ============================================================
// Debug Shaders
// ============================================================

export const DEBUG_VERTEX_SHADER = /* wgsl */ `
${CAMERA_STRUCT}

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

struct VertexInput {
    @location(0) position: vec3<f32>,
    @location(1) color: vec4<f32>,
};

struct VertexOutput {
    @builtin(position) clipPosition: vec4<f32>,
    @location(0) color: vec4<f32>,
};

@vertex
fn vs_main(input: VertexInput) -> VertexOutput {
    var output: VertexOutput;
    output.clipPosition = camera.projMatrix * camera.viewMatrix * vec4<f32>(input.position, 1.0);
    output.color = input.color;
    return output;
}
`;

export const DEBUG_FRAGMENT_SHADER = /* wgsl */ `
struct FragmentInput {
    @location(0) color: vec4<f32>,
};

@fragment
fn fs_main(input: FragmentInput) -> @location(0) vec4<f32> {
    return input.color;
}
`;
