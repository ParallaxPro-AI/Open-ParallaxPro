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

export const DECAL_VERTEX_SHADER = /* wgsl */ `
${CAMERA_STRUCT}

struct DecalData {
    modelMatrix: mat4x4<f32>,
    invModelMatrix: mat4x4<f32>,
    color: vec4<f32>,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<storage, read> decals: array<DecalData>;

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) instanceIndex: u32,
};

@vertex
fn vs_main(@location(0) cubePos: vec3<f32>, @builtin(instance_index) instanceIdx: u32) -> VertexOutput {
    let decal = decals[instanceIdx];
    let worldPos = decal.modelMatrix * vec4<f32>(cubePos, 1.0);
    var out: VertexOutput;
    out.position = camera.projMatrix * camera.viewMatrix * worldPos;
    out.instanceIndex = instanceIdx;
    return out;
}
`;

export const DECAL_FRAGMENT_SHADER = /* wgsl */ `
${CAMERA_STRUCT}

struct DecalData {
    modelMatrix: mat4x4<f32>,
    invModelMatrix: mat4x4<f32>,
    color: vec4<f32>,
};

struct DecalParams {
    invViewMatrix: mat4x4<f32>,
    projX: f32,         // projMatrix[0][0]
    projY: f32,         // projMatrix[1][1]
    viewportWidth: f32,
    viewportHeight: f32,
};

struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) @interpolate(flat) instanceIndex: u32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<storage, read> decals: array<DecalData>;
@group(2) @binding(0) var normalDepthTex: texture_2d<f32>;
@group(2) @binding(1) var<uniform> decalParams: DecalParams;

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
    // Read linear depth from normalDepth MRT (alpha channel)
    let coord = vec2<i32>(floor(in.position.xy));
    let nd = textureLoad(normalDepthTex, coord, 0);
    let linearDepth = nd.w;

    // Skip sky pixels
    if (linearDepth < 0.001) { discard; }

    // Reconstruct view-space position from screen position + linear depth
    let ndcX = (in.position.x / decalParams.viewportWidth) * 2.0 - 1.0;
    let ndcY = (1.0 - in.position.y / decalParams.viewportHeight) * 2.0 - 1.0;
    let viewX = ndcX * linearDepth / decalParams.projX;
    let viewY = ndcY * linearDepth / decalParams.projY;
    let viewPos = vec3<f32>(viewX, viewY, -linearDepth);

    // View to world
    let worldPos = (decalParams.invViewMatrix * vec4<f32>(viewPos, 1.0)).xyz;

    // Project world position into decal local space
    let decal = decals[in.instanceIndex];
    let localPos = (decal.invModelMatrix * vec4<f32>(worldPos, 1.0)).xyz;

    // Reject if outside decal box [-0.5, 0.5]
    if (any(localPos < vec3<f32>(-0.5)) || any(localPos > vec3<f32>(0.5))) { discard; }

    // Smooth edge falloff on X (across marking width) and Z (along marking length)
    let fadeX = 1.0 - smoothstep(0.35, 0.5, abs(localPos.x));
    let fadeZ = 1.0 - smoothstep(0.45, 0.5, abs(localPos.z));
    let fade = fadeX * fadeZ;

    let alpha = decal.color.a * fade;
    if (alpha < 0.01) { discard; }

    return vec4<f32>(decal.color.rgb, alpha);
}
`;
