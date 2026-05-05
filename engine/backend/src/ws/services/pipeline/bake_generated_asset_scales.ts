/**
 * Generated-asset scale baking (deprecated no-op).
 *
 * Originally this walked 02_entities.json and wrote mesh.scale = [N,N,N]
 * onto every def whose mesh.asset matched /assets/generated/<token>.glb.
 * That worked when the GLB loader didn't know about generated paths —
 * but the loader now resolves est_scale_m via /api/engine/models/asset-meta
 * and bakes the scale directly into the geometry (matching how kenney /
 * poly_haven assets work via MODEL_FACING.json). Baking mesh.scale on
 * top of the geometry bake double-scales: a sedan that was 4.6m would
 * become 21m on next reload, and the auto-fit collider would diverge
 * from the visible mesh.
 *
 * Kept as a no-op shim so the pipeline call sites in cli_creator.ts /
 * cli_fixer.ts don't need to be touched on this commit. Safe to delete
 * in a future cleanup pass.
 */
import { ProjectFiles } from './project_files.js';

export interface BakeResult {
    scaledDefs: string[];
    unresolvedPaths: string[];
}

export function bakeGeneratedAssetScales(_files: ProjectFiles): BakeResult {
    return { scaledDefs: [], unresolvedPaths: [] };
}
