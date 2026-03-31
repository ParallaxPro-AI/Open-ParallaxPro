export class EditorState {
    selectedEntityIds: number[] = [];
    selectedSceneId: number | null = null;
    projectId: string | null = null;
    projectData: any = null;
    projectDirty: boolean = false;
    activeScenePath: string | null = null;
    loadedScenes: Map<string, any> = new Map();
    gizmoMode: 'translate' | 'rotate' | 'scale' = 'translate';
    cameraMode: 'orbit' | 'fly' = 'orbit';
    gizmoSpace: 'global' | 'local' = 'global';
    isPlaying: boolean = false;
    prePlaySceneSnapshot: any = null;
    clipboard: any = null;
    lockedEntities: Set<number> = new Set();
    hiddenEntities: Set<number> = new Set();
    collapsedEntities: Set<number> = new Set();
    showCollisionMesh: boolean = false;
    collisionMeshHiddenEntities: Set<number> = new Set();
    collisionMeshOriginals: Map<number, { gpuMesh: any; baseColorTexture: any; normalMapTexture: any; gpuSubMeshes: any; materialOverrides: any }> = new Map();
    isMultiplayerGuest: boolean = false;
    terrainSculptActive: boolean = false;
    terrainSculptBrush: {
        radius: number;
        strength: number;
        mode: 'raise' | 'lower' | 'smooth' | 'flatten';
    } = { radius: 5, strength: 0.02, mode: 'raise' };
}
