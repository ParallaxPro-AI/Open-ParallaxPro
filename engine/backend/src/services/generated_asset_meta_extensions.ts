/**
 * Plugin-side resolvers for community / AI-generated asset metadata
 * (est_scale_m, axes, bbox). The engine itself doesn't know about
 * paths under /assets/generated/* — those are owned by hosted plugins
 * (model_gen). When pipeline post-processing or runtime loading needs
 * to know what scale to apply to a generated GLB, it asks here, the
 * registry calls every plugin resolver in turn, and returns the first
 * hit.
 *
 * Sync intentionally: the only known caller (model_gen → SQLite via
 * better-sqlite3) is sync, and CLI agent post-process is also sync.
 * Going async would force every hot-path call site to await.
 */

export interface GeneratedAssetMeta {
    /** Longest-axis size in meters. Engine treats this as the
     *  scale_to_meters target — non-longest axes scale proportionally. */
    est_scale_m: number;
    /** 'y' for canonical engines (gravity along -Y). */
    up_axis: string;
    /** TRELLIS.2 ships +z by default; the editor's drop handler rotates
     *  to align with the engine's -z forward. Re-applied at AI-content
     *  bake time to keep entity defs facing the right way. */
    forward_axis: string;
    /** Mesh-local AABB extents [[xmin,ymin,zmin],[xmax,ymax,zmax]] when
     *  available. Used to compute per-axis scale factors when the GLB
     *  isn't perfectly unit-cube. Optional — caller can fall back to
     *  uniform scale = est_scale_m. */
    bbox?: number[][];
}

type Resolver = (assetPath: string) => GeneratedAssetMeta | null;

const resolvers: Resolver[] = [];

export function registerGeneratedAssetMetaResolver(fn: Resolver): void {
    resolvers.push(fn);
}

/** Returns the first registered resolver's hit for `assetPath`, or null
 *  if none has metadata for it. Resolvers are tried in registration
 *  order; the first non-null wins. */
export function resolveGeneratedAssetMeta(assetPath: string): GeneratedAssetMeta | null {
    for (const fn of resolvers) {
        try {
            const m = fn(assetPath);
            if (m) return m;
        } catch (e: any) {
            console.error('[generated_asset_meta] resolver threw:', e?.message ?? e);
        }
    }
    return null;
}
