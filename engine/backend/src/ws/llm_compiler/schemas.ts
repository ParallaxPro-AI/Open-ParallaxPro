/**
 * Schema definitions — single source of truth for valid values.
 * The compiler and static analyzer validate against these.
 */

export const VALID_ENTITY_TYPES = new Set([
    'cube', 'sphere', 'cylinder', 'cone', 'capsule', 'plane',
    'empty', 'camera', 'directional_light', 'point_light', 'custom',
]);

export const VALID_COMPONENT_TYPES = new Set([
    'TransformComponent', 'MeshRendererComponent', 'CameraComponent', 'LightComponent',
    'RigidbodyComponent', 'ColliderComponent', 'ScriptComponent', 'TerrainComponent',
    'AudioSourceComponent', 'AudioListenerComponent', 'AnimatorComponent',
    'VehicleComponent', 'NetworkIdentityComponent',
]);

export const VALID_BODY_TYPES = new Set(['static', 'dynamic', 'kinematic']);

export const VALID_COLLIDER_SHAPES = new Set(['box', 'sphere', 'capsule', 'mesh', 'terrain']);

export const VALID_BLOCK_NAMES = new Set([
    'EDIT',
    'LIST_ASSETS',
    'GET_EDIT_API',
    'LOAD_TEMPLATE',
    'FIX_GAME',
    'CREATE_GAME',
    // Offers a "Create from scratch" button on the chat alongside the AI's
    // { } question. Unlike other tool calls this one does NOT steal a
    // follow-up turn — the AI emits it in the same response as the text
    // so the user sees both at once.
    'OFFER_CREATE_GAME',
]);
