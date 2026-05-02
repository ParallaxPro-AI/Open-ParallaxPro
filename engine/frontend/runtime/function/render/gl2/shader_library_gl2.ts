/**
 * GLSL ES 3.00 shaders for the WebGL2 fallback backend.
 *
 * V1.1 scope (matches the WebGL2 RenderPipeline's pass set):
 *   - "lit": forward PBR-ish geometry with directional + point + spot
 *     lights, ambient, fog, albedo + normal map sampling, hard shadow
 *     mapping via sampler2DShadow, optional skinning (`#define SKINNED`).
 *   - "shadow": depth-only output for the shadow caster pass.
 *   - "skybox": fullscreen-triangle gradient, time-of-day driven.
 *   - "debug_lines": positions + per-vertex color, no lighting.
 *
 * Vertex stride matches the WebGPU path's uploadMesh layout (32 bytes:
 * position(12) + normal(12) + uv(8)). Tangent space for normal mapping
 * is reconstructed in the fragment shader from screen-space derivatives,
 * so we don't need to grow MeshData with tangents.
 *
 * UBO layout follows std140 packing — vec3 fields are padded to 16
 * bytes by the spec, so JS-side encoders include the explicit pad
 * floats. Mismatches here are a common source of "renders fine on
 * desktop, garbage on iOS" bugs.
 */

export const MAX_JOINTS_GL2 = 64;
export const MAX_DIR_LIGHTS_GL2 = 4;
export const MAX_POINT_LIGHTS_GL2 = 8;
export const MAX_SPOT_LIGHTS_GL2 = 4;
/** Max instances per drawElementsInstanced batch. 128 mat4 = 8 KiB UBO,
 *  comfortably below WebGL2's MAX_UNIFORM_BLOCK_SIZE (16 KiB minimum
 *  spec, 64 KiB on most desktop drivers). Larger batches are split. */
export const MAX_INSTANCES_GL2 = 128;

const FRAME_UBO_DEFS = `
struct PointLight {
    vec4 posRange;             // xyz = world position, w = range
    vec4 colorIntensity;       // rgb = color * intensity, w = unused
};
struct SpotLight {
    vec4 posRange;             // xyz = pos, w = range
    vec4 dirInnerCos;          // xyz = direction, w = cos(innerConeAngle)
    vec4 colorOuterCos;        // rgb = color * intensity, w = cos(outerConeAngle)
};
layout(std140) uniform FrameUBO {
    mat4 u_viewMatrix;
    mat4 u_projMatrix;
    mat4 u_lightViewProj;      // dir-light shadow VP (light 0 only)
    vec4 u_cameraPos;          // .xyz; .w padding
    vec4 u_ambient;            // rgb × intensity, a = numDirLights
    vec4 u_dirLightDir[${MAX_DIR_LIGHTS_GL2}];
    vec4 u_dirLightColor[${MAX_DIR_LIGHTS_GL2}];
    vec4 u_fogParams;          // x=enabled, y=near, z=far, w=unused
    vec4 u_fogColor;
    vec4 u_misc;               // x=timeOfDay, y=numPointLights, z=numSpotLights, w=shadowEnabled
    PointLight u_pointLights[${MAX_POINT_LIGHTS_GL2}];
    SpotLight  u_spotLights[${MAX_SPOT_LIGHTS_GL2}];
};
`;

const MATERIAL_UBO_DEFS = `
layout(std140) uniform MaterialUBO {
    vec4 u_baseColor;          // rgba
    vec4 u_pbr;                // x=metallic, y=roughness, z=normalScale, w=hasNormalMap
    vec4 u_emissive;           // rgb
    vec4 u_uvScale;            // xy
    vec4 u_water;              // x=waterEffect, y=waterLevel, z=waterScale
};
`;

/** Build the instanced lit vertex shader. Reads per-instance model
 *  matrix from `u_models[gl_InstanceID]` (UBO) instead of the
 *  `u_modelMatrix` uniform the per-mesh path uses. Skinned variant is
 *  not generated — skinned meshes can't share a joints buffer across
 *  instances, so they always use the per-mesh path. */
export function buildLitInstancedVertexShader(): string {
    return `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

layout(std140) uniform InstanceModelsUBO {
    mat4 u_models[${MAX_INSTANCES_GL2}];
};

${FRAME_UBO_DEFS}
${MATERIAL_UBO_DEFS}

out vec3 v_worldPos;
out vec3 v_worldNormal;
out vec2 v_uv;
out vec4 v_lightSpacePos;

void main() {
    mat4 m = u_models[gl_InstanceID];
    vec4 worldPos = m * vec4(a_position, 1.0);
    v_worldPos     = worldPos.xyz;
    v_worldNormal  = normalize(mat3(m) * a_normal);
    v_uv           = a_uv * u_uvScale.xy;
    v_lightSpacePos = u_lightViewProj * worldPos;
    gl_Position    = u_projMatrix * u_viewMatrix * worldPos;
}
`;
}

export function buildLitVertexShader(skinned: boolean): string {
    return `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;
${skinned ? `
layout(location = 3) in uvec4 a_joints;
layout(location = 4) in vec4  a_weights;
` : ''}

uniform mat4 u_modelMatrix;

${FRAME_UBO_DEFS}
${MATERIAL_UBO_DEFS}

${skinned ? `
layout(std140) uniform JointsUBO {
    mat4 u_jointMatrices[${MAX_JOINTS_GL2}];
};
` : ''}

out vec3 v_worldPos;
out vec3 v_worldNormal;
out vec2 v_uv;
out vec4 v_lightSpacePos;

void main() {
    vec4 pos = vec4(a_position, 1.0);
    vec3 nrm = a_normal;

    ${skinned ? `
    mat4 skin = a_weights.x * u_jointMatrices[a_joints.x] +
                a_weights.y * u_jointMatrices[a_joints.y] +
                a_weights.z * u_jointMatrices[a_joints.z] +
                a_weights.w * u_jointMatrices[a_joints.w];
    pos = skin * pos;
    nrm = mat3(skin) * nrm;
    ` : ''}

    vec4 worldPos = u_modelMatrix * pos;
    v_worldPos     = worldPos.xyz;
    v_worldNormal  = normalize(mat3(u_modelMatrix) * nrm);
    v_uv           = a_uv * u_uvScale.xy;
    v_lightSpacePos = u_lightViewProj * worldPos;
    gl_Position    = u_projMatrix * u_viewMatrix * worldPos;
}
`;
}

export const LIT_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler2DShadow;

in vec3 v_worldPos;
in vec3 v_worldNormal;
in vec2 v_uv;
in vec4 v_lightSpacePos;

${FRAME_UBO_DEFS}
${MATERIAL_UBO_DEFS}

uniform sampler2D u_baseColorTex;
uniform sampler2D u_normalMap;
uniform sampler2DShadow u_shadowMap;

out vec4 fragColor;

/**
 * Reconstruct a TBN basis from screen-space derivatives so we can
 * sample tangent-space normal maps without per-vertex tangents.
 * Standard "Christian Schueler" cotangent frame formulation.
 */
mat3 cotangentFrame(vec3 N, vec3 worldPos, vec2 uv) {
    vec3 dp1 = dFdx(worldPos);
    vec3 dp2 = dFdy(worldPos);
    vec2 duv1 = dFdx(uv);
    vec2 duv2 = dFdy(uv);
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float invMax = inversesqrt(max(dot(T, T), dot(B, B)));
    return mat3(T * invMax, B * invMax, N);
}

float sampleShadow(vec4 lightSpacePos) {
    if (u_misc.w < 0.5) return 1.0;
    vec3 ndc = lightSpacePos.xyz / lightSpacePos.w;
    ndc = ndc * 0.5 + 0.5;
    if (ndc.x < 0.0 || ndc.x > 1.0 || ndc.y < 0.0 || ndc.y > 1.0 || ndc.z > 1.0) {
        return 1.0;
    }
    // Tiny constant bias on top of GL_POLYGON_OFFSET (slope-aware,
    // applied at rasterization time during the shadow pass). The big
    // fragment-side bias used to fix acne caused detached / "Peter
    // Panning" shadows on contact points; polygon-offset corrects acne
    // without that side-effect, leaving us a near-zero residual.
    float bias = 0.0008;
    return texture(u_shadowMap, vec3(ndc.xy, ndc.z - bias));
}

void main() {
    vec4 albedo = texture(u_baseColorTex, v_uv) * u_baseColor;

    vec3 N = normalize(v_worldNormal);
    if (u_pbr.w > 0.5) {
        vec3 nm = texture(u_normalMap, v_uv).xyz * 2.0 - 1.0;
        nm.xy *= u_pbr.z;
        mat3 TBN = cotangentFrame(N, v_worldPos, v_uv);
        N = normalize(TBN * nm);
    }

    bool isWater = u_water.x > 0.5 || v_worldPos.y <= u_water.y;

    if (isWater) {
        float t = u_fogColor.w;
        float wsInv = 1.0 / max(u_water.z, 0.001);
        float wpx = v_worldPos.x * wsInv;
        float wpz = v_worldPos.z * wsInv;
        float camDist = distance(u_cameraPos.xyz, v_worldPos);

        float warpAx = sin(wpx * 0.18 + wpz * 0.15 + t * 0.45) * 1.6;
        float warpAz = sin(wpz * 0.20 - wpx * 0.12 + t * 0.50) * 1.6;
        float warpBx = sin(wpx * 0.45 - wpz * 0.31 + t * 0.85) * 0.6;
        float warpBz = sin(wpz * 0.52 + wpx * 0.36 + t * 0.95) * 0.6;
        float qx = wpx + warpAx + warpBx;
        float qz = wpz + warpAz + warpBz;

        float waveNx = 0.0;
        float waveNz = 0.0;
        waveNx += cos(qx * 0.8 + qz * 0.3 + t * 0.9) * 0.28;
        waveNz += cos(qz * 1.0 - qx * 0.2 + t * 0.7) * 0.26;
        waveNx += cos(qx * 1.8 - qz * 0.6 + t * 1.4) * 0.17;
        waveNz += cos(qz * 2.2 + qx * 0.4 + t * 1.6) * 0.15;
        waveNx += cos(qx * 3.5 + qz * 1.5 + t * 2.5) * 0.09;
        waveNz += cos(qz * 4.0 - qx * 1.2 + t * 2.8) * 0.08;
        waveNx += cos(qx * 7.0 - qz * 3.0 + t * 3.8) * 0.045;
        waveNz += cos(qz * 8.5 + qx * 2.5 + t * 4.2) * 0.04;
        float lod5 = clamp(1.0 - camDist / 200.0, 0.0, 1.0);
        waveNx += cos(qx * 15.0 + qz * 7.0 + t * 5.5) * 0.025 * lod5;
        waveNz += cos(qz * 17.0 - qx * 6.0 + t * 6.0) * 0.022 * lod5;

        N = normalize(vec3(waveNx, 1.0, waveNz));

        vec3 deepColor = vec3(0.02, 0.08, 0.18);
        vec3 shallowColor = vec3(0.05, 0.35, 0.45);
        float viewDot = max(dot(vec3(0.0, 1.0, 0.0), normalize(u_cameraPos.xyz - v_worldPos)), 0.0);
        float depthBlend = pow(1.0 - viewDot, 2.0);
        albedo.rgb = mix(deepColor, shallowColor, depthBlend);

        float waveHeight = (waveNx + waveNz) * 0.5 + 0.5;
        albedo.rgb += vec3(0.08, 0.45, 0.35) * pow(waveHeight, 3.0) * 0.25;

        float steepness = 1.0 - N.y;
        float foam = smoothstep(0.12, 0.20, steepness);
        albedo.rgb = mix(albedo.rgb, vec3(0.85, 0.9, 0.95), foam * 0.7);
    }

    float upness = N.y * 0.5 + 0.5;
    float dayFactor = clamp(1.0 - abs(u_misc.x - 12.0) / 6.0, 0.0, 1.0);
    vec3 skyTint    = vec3(0.55, 0.70, 1.00);
    vec3 groundTint = vec3(0.45, 0.40, 0.32);
    vec3 hemi = mix(groundTint, skyTint, upness) * dayFactor;

    vec3 ambient = (u_ambient.rgb + hemi * u_fogParams.w) * albedo.rgb;
    vec3 color = ambient + u_emissive.rgb;

    const float INV_PI = 0.31830988618;

    int numDir = int(u_ambient.a);
    for (int i = 0; i < ${MAX_DIR_LIGHTS_GL2}; i++) {
        if (i >= numDir) break;
        vec3 L = normalize(-u_dirLightDir[i].xyz);
        float NdotL = max(dot(N, L), 0.0);
        float shadow = (i == 0) ? sampleShadow(v_lightSpacePos) : 1.0;
        color += u_dirLightColor[i].rgb * albedo.rgb * NdotL * shadow * INV_PI;
    }

    int numPoint = int(u_misc.y);
    for (int i = 0; i < ${MAX_POINT_LIGHTS_GL2}; i++) {
        if (i >= numPoint) break;
        PointLight pl = u_pointLights[i];
        vec3 toL = pl.posRange.xyz - v_worldPos;
        float dist = length(toL);
        if (dist > pl.posRange.w) continue;
        vec3 L = toL / max(dist, 1e-4);
        float NdotL = max(dot(N, L), 0.0);
        float d2 = dist * dist;
        float r2 = pl.posRange.w * pl.posRange.w;
        float windowing = clamp(1.0 - (d2 * d2) / (r2 * r2), 0.0, 1.0);
        float atten = (windowing * windowing) / (d2 + 1.0);
        color += pl.colorIntensity.rgb * albedo.rgb * NdotL * atten * INV_PI;
    }

    int numSpot = int(u_misc.z);
    for (int i = 0; i < ${MAX_SPOT_LIGHTS_GL2}; i++) {
        if (i >= numSpot) break;
        SpotLight sl = u_spotLights[i];
        vec3 toL = sl.posRange.xyz - v_worldPos;
        float dist = length(toL);
        if (dist > sl.posRange.w) continue;
        vec3 L = toL / max(dist, 1e-4);
        float NdotL = max(dot(N, L), 0.0);
        float spotCos = dot(-L, normalize(sl.dirInnerCos.xyz));
        float spotFactor = smoothstep(sl.colorOuterCos.w, sl.dirInnerCos.w, spotCos);
        if (spotFactor <= 0.0) continue;
        float d2 = dist * dist;
        float r2 = sl.posRange.w * sl.posRange.w;
        float windowing = clamp(1.0 - (d2 * d2) / (r2 * r2), 0.0, 1.0);
        float atten = (windowing * windowing) / (d2 + 1.0);
        color += sl.colorOuterCos.rgb * albedo.rgb * NdotL * atten * spotFactor * INV_PI;
    }

    if (isWater) {
        vec3 V = normalize(u_cameraPos.xyz - v_worldPos);
        float NdotV = max(dot(N, V), 0.0);
        vec3 fresnel = vec3(0.02) + vec3(0.98) * pow(1.0 - NdotV, 5.0);
        vec3 reflDir = reflect(-V, N);
        float skyUp = max(reflDir.y, 0.0);
        vec3 skyRefl = mix(vec3(0.55, 0.7, 0.85), vec3(0.25, 0.45, 0.75), skyUp);
        color = mix(color, skyRefl, fresnel);

        if (numDir > 0) {
            vec3 sunDir = normalize(-u_dirLightDir[0].xyz);
            vec3 H = normalize(V + sunDir);
            float NdotH = max(dot(N, H), 0.0);
            float glint = pow(NdotH, 512.0) * 2.0;
            color += u_dirLightColor[0].rgb * glint;
        }
    }

    if (u_fogParams.x > 0.5) {
        float dist = length(u_cameraPos.xyz - v_worldPos);
        float t = clamp((dist - u_fogParams.y) / max(u_fogParams.z - u_fogParams.y, 1e-4), 0.0, 1.0);
        color = mix(color, u_fogColor.rgb, t);
    }

    fragColor = vec4(color, albedo.a);
}
`;

/**
 * Depth-only shadow caster. Same skinning/static branch as the lit
 * vertex shader so animated characters cast shadows.
 */
/** Instanced shadow caster — like buildShadowVertexShader(false) but
 *  reads modelMatrix from `u_models[gl_InstanceID]`. Mirrors
 *  buildLitInstancedVertexShader in layout/binding so the same
 *  InstanceModelsUBO buffer can drive both the main and shadow passes. */
export function buildShadowInstancedVertexShader(): string {
    return `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;

layout(std140) uniform InstanceModelsUBO {
    mat4 u_models[${MAX_INSTANCES_GL2}];
};

uniform mat4 u_lightViewProj;

void main() {
    gl_Position = u_lightViewProj * u_models[gl_InstanceID] * vec4(a_position, 1.0);
}
`;
}

export function buildShadowVertexShader(skinned: boolean): string {
    return `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
${skinned ? `
layout(location = 3) in uvec4 a_joints;
layout(location = 4) in vec4  a_weights;
` : ''}

uniform mat4 u_modelMatrix;
uniform mat4 u_lightViewProj;

${skinned ? `
layout(std140) uniform JointsUBO {
    mat4 u_jointMatrices[${MAX_JOINTS_GL2}];
};
` : ''}

void main() {
    vec4 pos = vec4(a_position, 1.0);
    ${skinned ? `
    mat4 skin = a_weights.x * u_jointMatrices[a_joints.x] +
                a_weights.y * u_jointMatrices[a_joints.y] +
                a_weights.z * u_jointMatrices[a_joints.z] +
                a_weights.w * u_jointMatrices[a_joints.w];
    pos = skin * pos;
    ` : ''}
    gl_Position = u_lightViewProj * u_modelMatrix * pos;
}
`;
}

export const SHADOW_FRAGMENT_SHADER = `#version 300 es
precision highp float;
void main() {}
`;

export const SKYBOX_VERTEX_SHADER = `#version 300 es
precision highp float;
out vec2 v_screenUV;
void main() {
    vec2 p = vec2(
        (gl_VertexID == 1) ? 3.0 : -1.0,
        (gl_VertexID == 2) ? 3.0 : -1.0
    );
    v_screenUV = (p + 1.0) * 0.5;
    gl_Position = vec4(p, 0.0, 1.0);
}
`;

export const SKYBOX_FRAGMENT_SHADER = `#version 300 es
precision highp float;

in vec2 v_screenUV;
${FRAME_UBO_DEFS}

out vec4 fragColor;

void main() {
    float t = u_misc.x;
    float dayFactor = clamp(1.0 - abs(t - 12.0) / 6.0, 0.0, 1.0);
    float duskFactor = (t >= 17.0 && t <= 19.0) ? smoothstep(17.0, 18.0, t) * (1.0 - smoothstep(18.0, 19.0, t)) : 0.0;

    vec3 dayHorizon  = vec3(0.78, 0.86, 0.94);
    vec3 dayZenith   = vec3(0.40, 0.62, 0.92);
    vec3 nightHorizon = vec3(0.05, 0.07, 0.15);
    vec3 nightZenith  = vec3(0.01, 0.02, 0.06);
    vec3 duskTint    = vec3(0.90, 0.45, 0.25);

    vec3 horizon = mix(nightHorizon, dayHorizon, dayFactor);
    vec3 zenith  = mix(nightZenith, dayZenith, dayFactor);
    horizon = mix(horizon, duskTint, duskFactor * 0.6);

    vec3 sky = mix(horizon, zenith, smoothstep(0.0, 1.0, v_screenUV.y));
    fragColor = vec4(sky, 1.0);
}
`;

export const DEBUG_LINES_VERTEX_SHADER = `#version 300 es
precision highp float;
layout(location = 0) in vec3 a_position;
layout(location = 1) in vec4 a_color;
${FRAME_UBO_DEFS}
out vec4 v_color;
void main() {
    v_color = a_color;
    gl_Position = u_projMatrix * u_viewMatrix * vec4(a_position, 1.0);
}
`;

export const DEBUG_LINES_FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec4 v_color;
out vec4 fragColor;
void main() {
    fragColor = v_color;
}
`;

// ── Terrain shaders ─────────────────────────────────────────

export const TERRAIN_LAYER_PROPS_UBO_DEFS = `
layout(std140) uniform TerrainLayerPropsUBO {
    vec4 u_layerData[8];
};
`;

export function buildTerrainVertexShader(): string {
    return `#version 300 es
precision highp float;

layout(location = 0) in vec3 a_position;
layout(location = 1) in vec3 a_normal;
layout(location = 2) in vec2 a_uv;

uniform mat4 u_modelMatrix;

${FRAME_UBO_DEFS}

out vec3 v_worldPos;
out vec3 v_worldNormal;
out vec2 v_uv;
out vec4 v_lightSpacePos;

void main() {
    vec4 worldPos = u_modelMatrix * vec4(a_position, 1.0);
    v_worldPos     = worldPos.xyz;
    v_worldNormal  = normalize(mat3(u_modelMatrix) * a_normal);
    v_uv           = a_uv;
    v_lightSpacePos = u_lightViewProj * worldPos;
    gl_Position    = u_projMatrix * u_viewMatrix * worldPos;
}
`;
}

export const TERRAIN_FRAGMENT_SHADER_GL2 = `#version 300 es
precision highp float;
precision highp sampler2DArray;
precision highp sampler2DShadow;

in vec3 v_worldPos;
in vec3 v_worldNormal;
in vec2 v_uv;
in vec4 v_lightSpacePos;

${FRAME_UBO_DEFS}
${MATERIAL_UBO_DEFS}
${TERRAIN_LAYER_PROPS_UBO_DEFS}

uniform sampler2DShadow u_shadowMap;
uniform highp sampler2DArray u_groundDiffuse;
uniform highp sampler2DArray u_groundNormal;
uniform sampler2D u_splatmap;
uniform sampler2D u_roadAtlasNear;
uniform sampler2D u_roadAtlasFar;
uniform sampler2D u_sidewalkDiffuse;
uniform sampler2D u_sidewalkNormal;

out vec4 fragColor;

// ── Noise ──────────────────────────────────────────────────

vec2 hash2D(vec2 p) {
    vec2 k = vec2(0.3183099, 0.3678794);
    vec2 q = p * k + vec2(k.y, k.x);
    q = fract(q * 43758.5453);
    return fract(q * vec2(q.y + 71.0, q.x + 113.0)) * 2.0 - 1.0;
}

float gradientNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 ga = hash2D(i);
    vec2 gb = hash2D(i + vec2(1.0, 0.0));
    vec2 gc = hash2D(i + vec2(0.0, 1.0));
    vec2 gd = hash2D(i + vec2(1.0, 1.0));
    float va = dot(ga, f);
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));
    return mix(mix(va, vb, u.x), mix(vc, vd, u.x), u.y);
}

float fbmTerrain(vec2 p) {
    float val = 0.0;
    float amp = 0.5;
    vec2 pos = p;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 4; i++) {
        val += gradientNoise(pos) * amp;
        pos = rot * pos * 2.07;
        amp *= 0.48;
    }
    return val;
}

// ── Shadow ─────────────────────────────────────────────────

float sampleShadow(vec4 lightSpacePos) {
    if (u_misc.w < 0.5) return 1.0;
    vec3 ndc = lightSpacePos.xyz / lightSpacePos.w;
    ndc = ndc * 0.5 + 0.5;
    if (ndc.x < 0.0 || ndc.x > 1.0 || ndc.y < 0.0 || ndc.y > 1.0 || ndc.z > 1.0) return 1.0;
    return texture(u_shadowMap, vec3(ndc.xy, ndc.z - 0.0008));
}

// ── Normal mapping ─────────────────────────────────────────

mat3 cotangentFrame(vec3 N, vec3 worldPos, vec2 uv) {
    vec3 dp1 = dFdx(worldPos);
    vec3 dp2 = dFdy(worldPos);
    vec2 duv1 = dFdx(uv);
    vec2 duv2 = dFdy(uv);
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
    float invMax = inversesqrt(max(dot(T, T), dot(B, B)));
    return mat3(T * invMax, B * invMax, N);
}

// ── Ground layer sampling ──────────────────────────────────

vec3 sampleGroundLayerAlbedo(int layerIdx, vec2 worldXZ) {
    float uvScale = u_layerData[layerIdx].x;
    vec2 texUV = worldXZ * uvScale;
    return texture(u_groundDiffuse, vec3(texUV, float(layerIdx))).rgb;
}

vec3 sampleGroundLayerNormal(int layerIdx, vec2 worldXZ, vec3 N, vec3 worldPos) {
    float uvScale = u_layerData[layerIdx].x;
    vec2 texUV = worldXZ * uvScale;
    vec3 nm = texture(u_groundNormal, vec3(texUV, float(layerIdx))).xyz * 2.0 - 1.0;
    nm.xy *= 2.0;
    mat3 TBN = cotangentFrame(N, worldPos, texUV);
    return normalize(TBN * nm);
}

// ── Road atlas sampling ────────────────────────────────────

vec4 sampleRoadInfo(vec3 worldPos) {
    float chunkSize = 500.0;
    float chunkX = floor(worldPos.x / chunkSize);
    float chunkZ = floor(worldPos.z / chunkSize);
    float localU = fract(worldPos.x / chunkSize);
    float localV = fract(worldPos.z / chunkSize);

    float nearGrid = 8.0;
    float ntX = mod(mod(chunkX, nearGrid) + nearGrid, nearGrid);
    float ntZ = mod(mod(chunkZ, nearGrid) + nearGrid, nearGrid);
    vec2 nearUV = vec2((ntX + localU) / nearGrid, (ntZ + localV) / nearGrid);

    float farGrid = 32.0;
    float ftX = mod(mod(chunkX, farGrid) + farGrid, farGrid);
    float ftZ = mod(mod(chunkZ, farGrid) + farGrid, farGrid);
    vec2 farUV = vec2((ftX + localU) / farGrid, (ftZ + localV) / farGrid);

    vec4 nearSample = vec4(0.0);
    vec4 farSample = vec4(0.0);
    if (u_uvScale.z > 0.5) nearSample = texture(u_roadAtlasNear, nearUV);
    if (u_uvScale.w > 0.5) farSample = texture(u_roadAtlasFar, farUV);

    vec4 ri;
    ri.x = nearSample.r; ri.y = nearSample.g;
    ri.z = nearSample.b; ri.w = nearSample.a;
    if (ri.x < 0.01) { ri.x = farSample.r; ri.y = farSample.g; }
    if (ri.z < 0.01) { ri.z = farSample.b; ri.w = farSample.a; }
    return ri;
}

// ── Layer weights ──────────────────────────────────────────

vec4 computeLayerWeights(float h, float slopeY, vec2 worldXZ, vec4 naipW) {
    float naipTotal = naipW.x + naipW.y + naipW.z + naipW.w;
    vec4 weights;
    if (naipTotal > 0.05) {
        weights = naipW / naipTotal;
    } else {
        float n1 = fbmTerrain(worldXZ * 0.012) * 12.0;
        float n2 = gradientNoise(worldXZ * 0.04) * 6.0;
        float hN = h + n1 + n2;
        float w0 = smoothstep(7.0, 0.5, hN);
        float w1 = smoothstep(0.5, 3.0, hN) * smoothstep(80.0, 40.0, hN);
        float w2 = smoothstep(30.0, 55.0, hN) * smoothstep(250.0, 150.0, hN);
        float w3 = smoothstep(120.0, 180.0, hN);
        weights = vec4(w0, w1, w2, w3);
    }
    float slopeFactor = smoothstep(0.7, 0.35, abs(slopeY));
    weights = mix(weights, vec4(0.0, 0.0, 0.15, 0.85), slopeFactor);
    float total = weights.x + weights.y + weights.z + weights.w;
    if (total > 0.001) weights /= total;
    else weights = vec4(0.0, 1.0, 0.0, 0.0);
    return weights;
}

void main() {
    float h = v_worldPos.y;
    vec3 N = normalize(v_worldNormal);
    vec2 worldXZ = v_worldPos.xz;

    vec4 road = sampleRoadInfo(v_worldPos);

    vec3 s0a = sampleGroundLayerAlbedo(0, worldXZ);
    vec3 s1a = sampleGroundLayerAlbedo(1, worldXZ);
    vec3 s2a = sampleGroundLayerAlbedo(2, worldXZ);
    vec3 s3a = sampleGroundLayerAlbedo(3, worldXZ);
    vec3 s0n = sampleGroundLayerNormal(0, worldXZ, N, v_worldPos);
    vec3 s1n = sampleGroundLayerNormal(1, worldXZ, N, v_worldPos);
    vec3 s2n = sampleGroundLayerNormal(2, worldXZ, N, v_worldPos);
    vec3 s3n = sampleGroundLayerNormal(3, worldXZ, N, v_worldPos);

    vec2 swUV = worldXZ * 0.5;
    vec3 swDiff = texture(u_sidewalkDiffuse, swUV).rgb;

    vec2 worldDim = vec2(u_layerData[5].x, u_layerData[5].y);
    vec2 worldOrigin = vec2(u_layerData[5].z, u_layerData[5].w);
    vec2 weightUV = clamp((worldXZ - worldOrigin) / worldDim, vec2(0.0), vec2(1.0));
    vec4 weightSample = texture(u_splatmap, weightUV);

    vec2 contentDim = vec2(u_layerData[6].x, u_layerData[6].y);
    bool inOsm = contentDim.x <= 0.0 || contentDim.y <= 0.0
              || (worldXZ.x >= 0.0 && worldXZ.x <= contentDim.x
               && worldXZ.y >= 0.0 && worldXZ.y <= contentDim.y);
    if (!inOsm) { road.x = 0.0; road.z = 0.0; }

    vec4 weights = computeLayerWeights(h, N.y, worldXZ, weightSample);

    vec3 albedo;
    bool isWater = h <= u_water.y;

    if (isWater) {
        albedo = vec3(0.06, 0.15, 0.30);
    } else {
        albedo = s0a * weights.x + s1a * weights.y + s2a * weights.z + s3a * weights.w;
        N = normalize(s0n * weights.x + s1n * weights.y + s2n * weights.z + s3n * weights.w);
        float microNoise = gradientNoise(worldXZ * 0.005) * 0.08;
        albedo *= (1.0 + microNoise);

        if (road.x > 0.01) {
            float rc = clamp(road.x, 0.0, 1.0);
            float asphaltNoise = gradientNoise(worldXZ * 0.8) * 0.03;
            vec3 asphaltColor = vec3(0.20 + asphaltNoise, 0.20 + asphaltNoise, 0.22 + asphaltNoise);
            albedo = mix(albedo, asphaltColor, rc);
            N = mix(N, vec3(0.0, 1.0, 0.0), rc * 0.8);
        }
        if (road.z > 0.01) {
            float sc = clamp(road.z, 0.0, 1.0) * 0.3;
            albedo = mix(albedo, vec3(0.65, 0.63, 0.60), sc);
        }
    }

    if (isWater) {
        float t = u_fogColor.w;
        float wpx = v_worldPos.x;
        float wpz = v_worldPos.z;
        float camDist = distance(u_cameraPos.xyz, v_worldPos);

        float warpAx = sin(wpx * 0.18 + wpz * 0.15 + t * 0.45) * 1.6;
        float warpAz = sin(wpz * 0.20 - wpx * 0.12 + t * 0.50) * 1.6;
        float warpBx = sin(wpx * 0.45 - wpz * 0.31 + t * 0.85) * 0.6;
        float warpBz = sin(wpz * 0.52 + wpx * 0.36 + t * 0.95) * 0.6;
        float qx = wpx + warpAx + warpBx;
        float qz = wpz + warpAz + warpBz;

        float waveNx = 0.0, waveNz = 0.0;
        waveNx += cos(qx * 0.8 + qz * 0.3 + t * 0.9) * 0.28;
        waveNz += cos(qz * 1.0 - qx * 0.2 + t * 0.7) * 0.26;
        waveNx += cos(qx * 1.8 - qz * 0.6 + t * 1.4) * 0.17;
        waveNz += cos(qz * 2.2 + qx * 0.4 + t * 1.6) * 0.15;
        waveNx += cos(qx * 3.5 + qz * 1.5 + t * 2.5) * 0.09;
        waveNz += cos(qz * 4.0 - qx * 1.2 + t * 2.8) * 0.08;
        waveNx += cos(qx * 7.0 - qz * 3.0 + t * 3.8) * 0.045;
        waveNz += cos(qz * 8.5 + qx * 2.5 + t * 4.2) * 0.04;
        float lod5 = clamp(1.0 - camDist / 200.0, 0.0, 1.0);
        waveNx += cos(qx * 15.0 + qz * 7.0 + t * 5.5) * 0.025 * lod5;
        waveNz += cos(qz * 17.0 - qx * 6.0 + t * 6.0) * 0.022 * lod5;
        N = normalize(vec3(waveNx, 1.0, waveNz));

        vec3 deepColor = vec3(0.02, 0.08, 0.18);
        vec3 shallowColor = vec3(0.05, 0.35, 0.45);
        float viewDot = max(dot(vec3(0.0, 1.0, 0.0), normalize(u_cameraPos.xyz - v_worldPos)), 0.0);
        float depthBlend = pow(1.0 - viewDot, 2.0);
        albedo = mix(deepColor, shallowColor, depthBlend);
        albedo += vec3(0.08, 0.45, 0.35) * pow((waveNx + waveNz) * 0.5 + 0.5, 3.0) * 0.25;
        float foam = smoothstep(0.12, 0.20, 1.0 - N.y);
        albedo = mix(albedo, vec3(0.85, 0.9, 0.95), foam * 0.7);
    }

    // Lighting (Lambertian, matching GL2 lit shader)
    float upness = N.y * 0.5 + 0.5;
    float dayFactor = clamp(1.0 - abs(u_misc.x - 12.0) / 6.0, 0.0, 1.0);
    vec3 hemi = mix(vec3(0.45, 0.40, 0.32), vec3(0.55, 0.70, 1.00), upness) * dayFactor;
    vec3 ambient = (u_ambient.rgb + hemi * u_fogParams.w) * albedo;
    vec3 color = ambient;
    const float INV_PI = 0.31830988618;

    int numDir = int(u_ambient.a);
    for (int i = 0; i < ${MAX_DIR_LIGHTS_GL2}; i++) {
        if (i >= numDir) break;
        vec3 L = normalize(-u_dirLightDir[i].xyz);
        float NdotL = max(dot(N, L), 0.0);
        float shadow = (i == 0) ? sampleShadow(v_lightSpacePos) : 1.0;
        color += u_dirLightColor[i].rgb * albedo * NdotL * shadow * INV_PI;
    }

    int numPoint = int(u_misc.y);
    for (int i = 0; i < ${MAX_POINT_LIGHTS_GL2}; i++) {
        if (i >= numPoint) break;
        PointLight pl = u_pointLights[i];
        vec3 toL = pl.posRange.xyz - v_worldPos;
        float dist = length(toL);
        if (dist > pl.posRange.w) continue;
        vec3 L = toL / max(dist, 1e-4);
        float NdotL = max(dot(N, L), 0.0);
        float d2 = dist * dist;
        float r2 = pl.posRange.w * pl.posRange.w;
        float windowing = clamp(1.0 - (d2 * d2) / (r2 * r2), 0.0, 1.0);
        float atten = (windowing * windowing) / (d2 + 1.0);
        color += pl.colorIntensity.rgb * albedo * NdotL * atten * INV_PI;
    }

    if (isWater) {
        vec3 V = normalize(u_cameraPos.xyz - v_worldPos);
        float NdotV = max(dot(N, V), 0.0);
        vec3 fresnel = vec3(0.02) + vec3(0.98) * pow(1.0 - NdotV, 5.0);
        vec3 reflDir = reflect(-V, N);
        vec3 skyRefl = mix(vec3(0.55, 0.7, 0.85), vec3(0.25, 0.45, 0.75), max(reflDir.y, 0.0));
        color = mix(color, skyRefl, fresnel);
        if (numDir > 0) {
            vec3 sunDir = normalize(-u_dirLightDir[0].xyz);
            vec3 H = normalize(V + sunDir);
            float glint = pow(max(dot(N, H), 0.0), 512.0) * 2.0;
            color += u_dirLightColor[0].rgb * glint;
        }
    }

    if (u_fogParams.x > 0.5) {
        float dist = length(u_cameraPos.xyz - v_worldPos);
        float t = clamp((dist - u_fogParams.y) / max(u_fogParams.z - u_fogParams.y, 1e-4), 0.0, 1.0);
        color = mix(color, u_fogColor.rgb, t);
    }

    fragColor = vec4(color, 1.0);
}
`;

export function compileShader(gl: WebGL2RenderingContext, type: number, source: string, label: string): WebGLShader {
    const shader = gl.createShader(type);
    if (!shader) throw new Error(`gl.createShader returned null (${label})`);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(shader) ?? '<no log>';
        gl.deleteShader(shader);
        throw new Error(`Shader compile failed (${label}):\n${log}`);
    }
    return shader;
}

export function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader, label: string): WebGLProgram {
    const program = gl.createProgram();
    if (!program) throw new Error(`gl.createProgram returned null (${label})`);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) ?? '<no log>';
        gl.deleteProgram(program);
        throw new Error(`Program link failed (${label}):\n${log}`);
    }
    return program;
}

export function buildProgram(
    gl: WebGL2RenderingContext,
    vsSource: string,
    fsSource: string,
    label: string,
): WebGLProgram {
    const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource, label + '.vs');
    const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource, label + '.fs');
    const prog = linkProgram(gl, vs, fs, label);
    gl.detachShader(prog, vs);
    gl.detachShader(prog, fs);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    return prog;
}
