import { Vec3 } from '../../runtime/core/math/vec3.js';
import { Vec4 } from '../../runtime/core/math/vec4.js';
import { Entity } from '../../runtime/function/framework/entity.js';
import { Scene } from '../../runtime/function/framework/scene.js';
import { ParallaxEngine } from '../../runtime/engine.js';
import { loadScriptClass } from '../../runtime/function/scripting/script_loader.js';
import { GameUISystem } from '../../runtime/function/ui/game_ui.js';
import { AudioSystem } from '../../runtime/function/audio/audio_system.js';
import { TerrainComponent } from '../../runtime/function/framework/components/terrain_component.js';

import { buildScriptScene as sharedBuildScriptScene } from '../../../shared/scripting/script_scene_builder.js';
import { installDefaultNetworkAdapter } from '../../runtime/function/network/default_network_adapter.js';

export function computeScreenToWorldRay(
    screenX: number, screenY: number, scene: Scene, engine: ParallaxEngine,
): { origin: { x: number; y: number; z: number }; direction: { x: number; y: number; z: number } } | null {
    const cam = (scene as any).getActiveCamera();
    if (!cam) return null;
    const canvas = (engine.globalContext.renderSystem as any).getCanvas?.()
        ?? document.querySelector('.viewport-canvas-container canvas') as HTMLCanvasElement | null;
    if (!canvas) return null;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return null;
    const ndcX = (screenX / width) * 2 - 1;
    const ndcY = 1 - (screenY / height) * 2;
    const vp = cam.projectionMatrix.multiply(cam.viewMatrix);
    const invVP = vp.inverse();
    if (!invVP) return null;
    const nearClip = invVP.transformVec4(new Vec4(ndcX, ndcY, -1, 1));
    const farClip = invVP.transformVec4(new Vec4(ndcX, ndcY, 1, 1));
    if (Math.abs(nearClip.w) < 1e-12 || Math.abs(farClip.w) < 1e-12) return null;
    const nearW = new Vec3(nearClip.x / nearClip.w, nearClip.y / nearClip.w, nearClip.z / nearClip.w);
    const farW = new Vec3(farClip.x / farClip.w, farClip.y / farClip.w, farClip.z / farClip.w);
    const dx = farW.x - nearW.x;
    const dy = farW.y - nearW.y;
    const dz = farW.z - nearW.z;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-12) return null;
    return {
        origin: { x: nearW.x, y: nearW.y, z: nearW.z },
        direction: { x: dx / len, y: dy / len, z: dz / len },
    };
}

export function doRaycast(
    scene: Scene, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number,
    excludeEntityId?: number,
): any {
    let closestHit: any = null;
    let closestDist = maxDist;
    const dLen = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (dLen < 0.0001) return null;
    const ndx = dx / dLen, ndy = dy / dLen, ndz = dz / dLen;
    for (const entity of scene.entities.values()) {
        if (!entity.active) continue;
        if (excludeEntityId !== undefined && (entity.id === excludeEntityId || (entity as any).parentId === excludeEntityId)) continue;
        const tags = entity.tags;
        if (tags instanceof Set ? tags.has('ground') : (tags as any)?.includes?.('ground')) continue;
        const mr = entity.getComponent('MeshRendererComponent') as any;
        if (!mr || !mr.visible || !mr.gpuMesh) continue;
        const wp = entity.getWorldPosition();
        const ws = entity.getWorldScale();
        const bMin = mr.gpuMesh.boundMin;
        const bMax = mr.gpuMesh.boundMax;
        let minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number;
        if (bMin && bMax) {
            minX = wp.x + ws.x * bMin.x; minY = wp.y + ws.y * bMin.y; minZ = wp.z + ws.z * bMin.z;
            maxX = wp.x + ws.x * bMax.x; maxY = wp.y + ws.y * bMax.y; maxZ = wp.z + ws.z * bMax.z;
        } else {
            const r = (mr.gpuMesh.boundRadius ?? 0.5) * Math.max(Math.abs(ws.x), Math.abs(ws.y), Math.abs(ws.z));
            minX = wp.x - r; minY = wp.y - r; minZ = wp.z - r;
            maxX = wp.x + r; maxY = wp.y + r; maxZ = wp.z + r;
        }
        if (minX > maxX) { const t = minX; minX = maxX; maxX = t; }
        if (minY > maxY) { const t = minY; minY = maxY; maxY = t; }
        if (minZ > maxZ) { const t = minZ; minZ = maxZ; maxZ = t; }
        const invX = Math.abs(ndx) > 1e-8 ? 1 / ndx : (ndx >= 0 ? 1e8 : -1e8);
        const invY = Math.abs(ndy) > 1e-8 ? 1 / ndy : (ndy >= 0 ? 1e8 : -1e8);
        const invZ = Math.abs(ndz) > 1e-8 ? 1 / ndz : (ndz >= 0 ? 1e8 : -1e8);
        let t1 = (minX - ox) * invX, t2 = (maxX - ox) * invX;
        if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
        let t3 = (minY - oy) * invY, t4 = (maxY - oy) * invY;
        if (t3 > t4) { const t = t3; t3 = t4; t4 = t; }
        let tMin = t1 > t3 ? t1 : t3;
        let tMax = t2 < t4 ? t2 : t4;
        if (tMin > tMax) continue;
        let t5 = (minZ - oz) * invZ, t6 = (maxZ - oz) * invZ;
        if (t5 > t6) { const t = t5; t5 = t6; t6 = t; }
        if (tMin > t6 || t5 > tMax) continue;
        if (t5 > tMin) tMin = t5;
        if (t6 < tMax) tMax = t6;
        if (tMin < 0) tMin = tMax;
        if (tMin < 0 || tMin >= closestDist) continue;
        closestDist = tMin;
        const hx = ox + ndx * tMin, hy = oy + ndy * tMin, hz = oz + ndz * tMin;
        let nx = 0, ny = 0, nz = 0;
        const eps = 0.001;
        if (Math.abs(hx - minX) < eps) nx = -1;
        else if (Math.abs(hx - maxX) < eps) nx = 1;
        else if (Math.abs(hy - minY) < eps) ny = -1;
        else if (Math.abs(hy - maxY) < eps) ny = 1;
        else if (Math.abs(hz - minZ) < eps) nz = -1;
        else if (Math.abs(hz - maxZ) < eps) nz = 1;
        else ny = 1;
        closestHit = {
            entityId: entity.id,
            entityName: entity.name,
            distance: tMin,
            point: new Vec3(hx, hy, hz),
            normal: new Vec3(nx, ny, nz),
        };
    }
    return closestHit;
}

export interface ScriptSceneDeps {
    scene: Scene;
    engine: ParallaxEngine;
    scriptSystem: any;
    classMap: Map<string, new () => any>;
    projectScripts: Record<string, string>;
    gameUI: GameUISystem;
    gameAudio: AudioSystem;
    ensurePrimitiveMeshes: () => void;
    state: { projectData: any };
    uiSendState?: (state: any) => void;
    reloadScene?: () => void;
}

export function buildScriptScene(deps: ScriptSceneDeps): { scriptScene: any; makeScriptEntity: (entity: Entity) => any } {
    const { scene, engine, scriptSystem, classMap, projectScripts, gameUI, gameAudio, ensurePrimitiveMeshes, state } = deps;

    const sharedDeps: ScriptSceneDeps & Record<string, any> = {
        scene,
        engine,
        scriptSystem,
        classMap,
        projectScripts,
        gameUI,
        gameAudio,
        ensurePrimitiveMeshes,
        loadScriptClass: loadScriptClass,
        state,
        uiSendState: deps.uiSendState,

        raycast: (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, maxDist: number) => {
            const player = (scene as any).getEntityByName?.('Player') ?? [...scene.entities.values()].find(e => e.name === 'Player');
            return doRaycast(scene, ox, oy, oz, dx, dy, dz, maxDist, player?.id);
        },

        screenToWorldRay: (screenX: number, screenY: number) =>
            computeScreenToWorldRay(screenX, screenY, scene, engine),

        screenRaycast: (screenX: number, screenY: number, maxDist: number = 200) => {
            const ray = computeScreenToWorldRay(screenX, screenY, scene, engine);
            if (!ray) return null;
            return doRaycast(scene, ray.origin.x, ray.origin.y, ray.origin.z, ray.direction.x, ray.direction.y, ray.direction.z, maxDist);
        },

        worldToScreen: (wx: number, wy: number, wz: number) => {
            const cam = (scene as any).getActiveCamera();
            if (!cam) return null;
            const canvas = (engine.globalContext.renderSystem as any).getCanvas?.()
                ?? document.querySelector('.viewport-canvas-container canvas') as HTMLCanvasElement | null;
            if (!canvas) return null;
            const width = canvas.clientWidth;
            const height = canvas.clientHeight;
            if (width === 0 || height === 0) return null;
            const vp = cam.projectionMatrix.multiply(cam.viewMatrix);
            const clip = vp.transformVec4(new Vec4(wx, wy, wz, 1));
            if (clip.w <= 0) return null;
            const ndcX = clip.x / clip.w;
            const ndcY = clip.y / clip.w;
            return {
                x: (ndcX + 1) * 0.5 * width,
                y: (1 - ndcY) * 0.5 * height,
            };
        },

        screenPointToGround: (screenX: number, screenY: number, groundY: number = 0) => {
            const ray = computeScreenToWorldRay(screenX, screenY, scene, engine);
            if (!ray) return null;
            const dy = ray.direction.y;
            if (Math.abs(dy) < 1e-8) return null;
            const t = (groundY - ray.origin.y) / dy;
            if (t < 0) return null;
            return {
                x: ray.origin.x + ray.direction.x * t,
                y: groundY,
                z: ray.origin.z + ray.direction.z * t,
            };
        },

        setMeshData: (entityId: number, positions: Float32Array, normals: Float32Array, uvs: Float32Array, indices: Uint32Array) => {
            const entity = scene.getEntity(entityId);
            if (!entity) return;
            const mr = entity.getComponent('MeshRendererComponent') as any;
            if (!mr) return;
            const renderSystem = engine.globalContext.renderSystem;
            if (mr.gpuMesh && mr._isCustomMesh) {
                renderSystem.releaseMesh(mr.gpuMesh);
            }
            mr.gpuMesh = renderSystem.uploadMesh({ positions, normals, uvs, indices });
            mr._isCustomMesh = true;
        },

        getTerrainHeight: (x: number, z: number) => {
            for (const entity of scene.entities.values()) {
                const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
                if (terrain) {
                    const worldPos = entity.getWorldPosition();
                    return terrain.getHeightAt(x - worldPos.x, z - worldPos.z) + worldPos.y;
                }
            }
            return 0;
        },

        getTerrainNormal: (x: number, z: number) => {
            for (const entity of scene.entities.values()) {
                const terrain = entity.getComponent('TerrainComponent') as TerrainComponent | null;
                if (terrain) {
                    const worldPos = entity.getWorldPosition();
                    const n = terrain.getNormalAt(x - worldPos.x, z - worldPos.z);
                    return { x: n.x, y: n.y, z: n.z };
                }
            }
            return { x: 0, y: 1, z: 0 };
        },

        loadScene: (sceneName: string, fadeMs?: number) => {
            const wm = engine.globalContext.worldManager;
            if (wm) wm.transitionToScene(sceneName, fadeMs ?? 300);
        },

        getSceneNames: () => {
            const pd = state.projectData;
            if (!pd || !pd.scenes) return [];
            return Object.keys(pd.scenes).map((k: string) => k.replace('scenes/', '').replace('.scene.json', ''));
        },

        saveData: (key: string, data: any) => {
            const projectId = (state as any).projectId ?? 'unknown';
            const prefix = `parallaxpro_save_${projectId}_`;
            localStorage.setItem(prefix + key, JSON.stringify(data));
        },
        loadData: (key: string) => {
            const projectId = (state as any).projectId ?? 'unknown';
            const prefix = `parallaxpro_save_${projectId}_`;
            const raw = localStorage.getItem(prefix + key);
            return raw ? JSON.parse(raw) : null;
        },
        deleteData: (key: string) => {
            const projectId = (state as any).projectId ?? 'unknown';
            const prefix = `parallaxpro_save_${projectId}_`;
            localStorage.removeItem(prefix + key);
        },
        listSaveKeys: () => {
            const projectId = (state as any).projectId ?? 'unknown';
            const prefix = `parallaxpro_save_${projectId}_`;
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const k = localStorage.key(i);
                if (k && k.startsWith(prefix)) keys.push(k.substring(prefix.length));
            }
            return keys;
        },

        scheduleCall: (fn: () => void, delayMs: number) => setTimeout(fn, delayMs),
    };

    const result = sharedBuildScriptScene(sharedDeps as any);
    // Expose the peer-to-peer multiplayer session + project config on the
    // scriptScene so the mp_bridge system and any multiplayer game script can
    // talk to them without depending on global window state. `_mp` is the new
    // p2p session; the legacy `_multiplayer` (editor's MultiplayerManager) is
    // set separately when the user enters the editor's multiplayer flow.
    try {
        const projectConfig = state.projectData?.projectConfig ?? {};
        // Merge assembled multiplayer config (server-built) into projectConfig
        // so mp_bridge can read tickRate, min/max players, prediction flag, etc.
        const mpConfig = state.projectData?.multiplayerConfig;
        // Lobby shard key: project + updatedAt. Same project + same
        // updatedAt means same bytes, so it's safe to share a session.
        // Republishing as the same version string still bumps updatedAt
        // on the backend row, so v1.0.0 republished today is a different
        // shard than v1.0.0 from yesterday — prevents mixed-script
        // sessions where one peer has the new scripts and the other
        // hasn't refreshed.
        // Editor projects use the project row's updated_at (only bumps
        // on actual saves, so two tabs sharing the loaded snapshot share
        // a pool). "dev" is the last-resort fallback.
        const projectIdRaw = projectConfig.gameTemplateId || (state as any).projectId || 'default';
        const versionRaw = (state.projectData as any)?.updatedAt || 'dev';
        const lobbyKey = `${projectIdRaw}@${versionRaw}`;
        const merged = mpConfig
            ? { ...projectConfig, multiplayerConfig: mpConfig, gameTemplateId: lobbyKey }
            : projectConfig;
        (result.scriptScene as any)._mp = engine.globalContext.multiplayerSession;
        (result.scriptScene as any)._projectConfig = merged;
        (result.scriptScene as any)._engine = engine;

        // Bind the default scene ↔ session adapter so host snapshots and
        // client inputs move automatically as long as entities declare a
        // NetworkIdentityComponent.
        if (mpConfig?.enabled !== false) {
            installDefaultNetworkAdapter(
                engine.globalContext.multiplayerSession,
                scene as any,
                engine.globalContext.inputSystem,
                // After a remote-driven spawn, kick the editor's primitive
                // mesh upload pass so sphere/capsule meshes for the new
                // entity reach the GPU.
                () => { try { ensurePrimitiveMeshes(); } catch { /* ignored */ } },
            );
        }
    } catch { /* ignored — editor-less contexts */ }
    return result;
}
