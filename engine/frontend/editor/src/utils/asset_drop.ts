/**
 * Helpers for creating entities from dropped asset library items.
 */

export function prettifyAssetName(name: string): string {
    return name.replace(/[_-]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function buildComponentsForAsset(
    asset: { name: string; category: string; extension: string; fileUrl: string },
    pos: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 },
): { type: string; data?: Record<string, any> }[] {
    const transform = {
        type: 'TransformComponent',
        data: {
            position: { x: pos.x, y: pos.y, z: pos.z },
            rotation: { x: 0, y: 0, z: 0, w: 1 },
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
