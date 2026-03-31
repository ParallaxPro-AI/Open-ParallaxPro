export function addDefaultSceneEntities(scene: any): void {
    const cam = scene.createEntity('Main Camera');
    cam.addComponent('TransformComponent', {
        position: { x: 0, y: 3, z: 5 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 1, y: 1, z: 1 },
    });
    cam.addComponent('CameraComponent', {
        mode: 0, fov: 60, nearClip: 0.1, farClip: 1000, priority: 0,
    });

    const light = scene.createEntity('Directional Light');
    light.addComponent('TransformComponent', {
        position: { x: 0, y: 10, z: 0 },
        rotation: { x: -0.3, y: 0.5, z: 0, w: 0.85 },
        scale: { x: 1, y: 1, z: 1 },
    });
    light.addComponent('LightComponent', {
        lightType: 0, color: { r: 1, g: 0.95, b: 0.9, a: 1 }, intensity: 1.0,
    });

    const plane = scene.createEntity('Ground Plane');
    plane.addComponent('TransformComponent', {
        position: { x: 0, y: -0.5, z: 0 },
        rotation: { x: 0, y: 0, z: 0, w: 1 },
        scale: { x: 100, y: 1, z: 100 },
    });
    plane.addComponent('MeshRendererComponent', {
        meshType: 'cube',
        castShadows: false, receiveShadows: true, visible: true,
        materialOverrides: { baseColor: [0.3, 0.35, 0.3, 1] },
    });
    plane.addComponent('ColliderComponent', { shapeType: 0, size: { x: 1, y: 1, z: 1 } });
    plane.addComponent('RigidbodyComponent', { mass: 0, bodyType: 'static' });
}
