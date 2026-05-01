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
};
`;

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

    // Hemispherical sky-tint ambient — fakes the "look-up sees blue sky,
    // look-down sees ground" lighting that real IBL probes provide. The
    // WebGPU path doesn't have this either, but its specular term and
    // bloom carry the visual weight; on the WebGL2 fallback this is the
    // cheapest way to recover scene brightness without a real IBL pass.
    // Scaled by daylight so night scenes don't get an unnatural blue
    // tint. Always additive, never subtractive — only brightens.
    float upness = N.y * 0.5 + 0.5;
    float dayFactor = clamp(1.0 - abs(u_misc.x - 12.0) / 6.0, 0.0, 1.0);
    vec3 skyTint    = vec3(0.55, 0.70, 1.00);
    vec3 groundTint = vec3(0.45, 0.40, 0.32);
    vec3 hemi = mix(groundTint, skyTint, upness) * dayFactor;

    vec3 ambient = (u_ambient.rgb + hemi * u_fogParams.w) * albedo.rgb;
    vec3 color = ambient + u_emissive.rgb;

    // Directional lights — only the first casts shadows (matches the
    // WebGPU path's main-light convention, and we only have one shadow
    // map to sample).
    int numDir = int(u_ambient.a);
    for (int i = 0; i < ${MAX_DIR_LIGHTS_GL2}; i++) {
        if (i >= numDir) break;
        vec3 L = normalize(-u_dirLightDir[i].xyz);
        float NdotL = max(dot(N, L), 0.0);
        float shadow = (i == 0) ? sampleShadow(v_lightSpacePos) : 1.0;
        color += u_dirLightColor[i].rgb * albedo.rgb * NdotL * shadow;
    }

    // Point lights
    int numPoint = int(u_misc.y);
    for (int i = 0; i < ${MAX_POINT_LIGHTS_GL2}; i++) {
        if (i >= numPoint) break;
        PointLight pl = u_pointLights[i];
        vec3 toL = pl.posRange.xyz - v_worldPos;
        float dist = length(toL);
        if (dist > pl.posRange.w) continue;
        vec3 L = toL / max(dist, 1e-4);
        float NdotL = max(dot(N, L), 0.0);
        // Inverse-square with smooth range cutoff (matches the WebGPU
        // path closely enough that swap-over isn't jarring).
        float atten = 1.0 / (1.0 + dist * dist);
        float rangeFade = 1.0 - smoothstep(pl.posRange.w * 0.75, pl.posRange.w, dist);
        color += pl.colorIntensity.rgb * albedo.rgb * NdotL * atten * rangeFade;
    }

    // Spot lights
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
        float atten = 1.0 / (1.0 + dist * dist);
        float rangeFade = 1.0 - smoothstep(sl.posRange.w * 0.75, sl.posRange.w, dist);
        color += sl.colorOuterCos.rgb * albedo.rgb * NdotL * atten * rangeFade * spotFactor;
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
