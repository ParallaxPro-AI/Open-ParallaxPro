/**
 * Helpers for creating entities from dropped asset library items.
 */

export function prettifyAssetName(name: string): string {
    return name.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** Quaternion that rotates the asset's local-forward to match engine
 *  forward (-Z). Returns identity for assets without metadata or whose
 *  forward already aligns with engine forward.
 *
 *  Generated assets (TRELLIS.2 output) face +Z by default — without
 *  this, dragging them in shows their back to the camera. */
function alignmentRotation(forwardAxis: string | undefined): { x: number; y: number; z: number; w: number } {
    switch (forwardAxis) {
        // 180° around Y: flip front-to-back.
        case '+z': return { x: 0, y: 1, z: 0, w: 0 };
        // -90° around Y: model's +X face becomes engine -Z.
        case '+x': return { x: 0, y: -Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
        // 90° around Y: model's -X face becomes engine -Z.
        case '-x': return { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 };
        // -z (engine default), missing, anything else → identity.
        default: return { x: 0, y: 0, z: 0, w: 1 };
    }
}

export function buildComponentsForAsset(
    asset: { name: string; category: string; extension: string; fileUrl: string; forward_axis?: string },
    pos: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): { type: string; data?: Record<string, any> }[] {
    const transform = {
        type: 'TransformComponent',
        data: {
            position: { x: pos.x, y: pos.y, z: pos.z },
            rotation: alignmentRotation(asset.forward_axis),
            scale: { x: 1, y: 1, z: 1 },
        },
    };

    switch (asset.category) {
        case '3D Models':
        case 'Characters':
            return [
                transform,
                {
                    type: 'MeshRendererComponent',
                    data: { meshType: 'custom', meshAsset: asset.fileUrl },
                },
                {
                    type: 'RigidbodyComponent',
                    data: { bodyType: 'static', mass: 1, freezeRotation: false },
                },
                {
                    type: 'ColliderComponent',
                    data: { shapeType: asset.category === 'Characters' ? 'capsule' : 'mesh', size: { x: 1, y: 1, z: 1 } },
                },
            ];

        case 'Audio':
            return [
                transform,
                {
                    type: 'AudioSourceComponent',
                    data: { audioAsset: asset.fileUrl, playOnStart: false },
                },
            ];

        case 'Scripts':
            return [
                transform,
                {
                    type: 'ScriptComponent',
                    data: { scriptURL: asset.fileUrl },
                },
            ];

        case 'Textures':
        case 'UI':
        default:
            return [transform];
    }
}
