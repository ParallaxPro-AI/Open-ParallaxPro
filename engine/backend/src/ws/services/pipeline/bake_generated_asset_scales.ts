/**
 * Bake real-world scale onto entity defs that reference
 * /assets/generated/<token>.glb. Runs once over the post-CLI ProjectFiles
 * tree so the def in 02_entities.json carries mesh.scale = [N,N,N]
 * before the project lands on disk — keeps the per-project freeze
 * contract (admin scale changes never retroactively warp existing
 * scenes).
 *
 * BC-safe: skips defs that already have mesh.scale set (a hand-tuned
 * value is the source of truth — agent prompts say "OMIT scale" but if
 * a def has one we don't clobber it). Skips paths the resolver doesn't
 * know about (generally pack assets — those go through MODEL_FACING.json).
 */
import { ProjectFiles } from './project_files.js';
import { resolveGeneratedAssetMeta } from '../../../services/generated_asset_meta_extensions.js';

const GENERATED_PATH_RE = /^\/assets\/generated\/[a-f0-9]{2}\/[a-f0-9]{2}\/[a-f0-9]{32}\.glb$/;

export interface BakeResult {
    /** Defs that got a mesh.scale baked in this pass. Useful for logs. */
    scaledDefs: string[];
    /** Generated paths the resolver didn't recognize — admin queue
     *  should surface these so the predictor can fill them in. */
    unresolvedPaths: string[];
}

export function bakeGeneratedAssetScales(files: ProjectFiles): BakeResult {
    const result: BakeResult = { scaledDefs: [], unresolvedPaths: [] };
    const entitiesRaw = files['02_entities.json'];
    if (!entitiesRaw) return result;

    let doc: any;
    try { doc = JSON.parse(entitiesRaw); }
    catch { return result; }

    const defs = doc?.definitions;
    if (!defs || typeof defs !== 'object') return result;

    let dirty = false;
    for (const [defName, def] of Object.entries(defs as Record<string, any>)) {
        if (!def || typeof def !== 'object') continue;
        const mesh = def.mesh;
        if (!mesh || mesh.type !== 'custom') continue;
        const asset: string | undefined = mesh.asset;
        if (!asset || !GENERATED_PATH_RE.test(asset)) continue;

        // Don't clobber an existing scale — author intent wins.
        if (Array.isArray(mesh.scale) && mesh.scale.length === 3) continue;

        const meta = resolveGeneratedAssetMeta(asset);
        if (!meta) {
            result.unresolvedPaths.push(asset);
            continue;
        }

        // Uniform scale: TRELLIS-generated GLBs are bounded by ~1m unit
        // cube, so multiplying by est_scale_m makes the longest axis
        // equal that many meters. If we have a bbox we could be more
        // precise (divide by max-extent), but the unit-cube assumption
        // is good to <5% and avoids round-trip arithmetic risks.
        const s = meta.est_scale_m;
        if (!Number.isFinite(s) || s <= 0) continue;
        mesh.scale = [s, s, s];
        result.scaledDefs.push(defName);
        dirty = true;
    }

    if (dirty) {
        files['02_entities.json'] = JSON.stringify(doc, null, 2);
    }
    return result;
}
