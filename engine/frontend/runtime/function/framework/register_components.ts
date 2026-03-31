import { registerComponent } from './component_registry.js';

import { TransformComponent } from './components/transform_component.js';
import { MeshRendererComponent } from './components/mesh_renderer_component.js';
import { CameraComponent } from './components/camera_component.js';
import { LightComponent } from './components/light_component.js';
import { RigidbodyComponent } from './components/rigidbody_component.js';
import { ColliderComponent } from './components/collider_component.js';
import { AudioSourceComponent } from './components/audio_source_component.js';
import { AudioListenerComponent } from './components/audio_listener_component.js';
import { AnimatorComponent } from './components/animator_component.js';
import { ScriptComponent } from './components/script_component.js';
import { NetworkIdentityComponent } from './components/network_identity_component.js';
import { TerrainComponent } from './components/terrain_component.js';
import { VehicleComponent } from './components/vehicle_component.js';

export function registerBuiltInComponents(): void {
    registerComponent('TransformComponent', TransformComponent);
    registerComponent('MeshRendererComponent', MeshRendererComponent);
    registerComponent('CameraComponent', CameraComponent);
    registerComponent('LightComponent', LightComponent);
    registerComponent('RigidbodyComponent', RigidbodyComponent);
    registerComponent('ColliderComponent', ColliderComponent);
    registerComponent('AudioSourceComponent', AudioSourceComponent);
    registerComponent('AudioListenerComponent', AudioListenerComponent);
    registerComponent('AnimatorComponent', AnimatorComponent);
    registerComponent('ScriptComponent', ScriptComponent);
    registerComponent('NetworkIdentityComponent', NetworkIdentityComponent);
    registerComponent('TerrainComponent', TerrainComponent);
    registerComponent('VehicleComponent', VehicleComponent);
}
