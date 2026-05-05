/**
 * Plugin-side extensions to /api/engine/internal/search-assets.
 *
 * Core engine ships pack assets (kenney, poly_haven, quaternius, official)
 * via routes/assets.ts. Hosted plugins — model_gen in particular — own
 * additional asset pools (AI-generated GLBs in generated_models) that
 * should appear in the same search results without coupling routes/assets
 * to plugin internals.
 *
 * Pattern: a plugin's onStartup calls registerAssetSearchExtension(fn);
 * routes/assets.ts's searchAssets() awaits all registered extensions
 * after running its pack search and merges the rows into the response.
 *
 * Extension contract:
 *   - Return zero or more rows in the same shape pack assets use.
 *   - Be idempotent + safe under concurrent calls.
 *   - Never throw — log and return [].
 *   - Score-rank internally; the merge layer interleaves but doesn't
 *     re-rank. If you want to be obviously the best result, return
 *     fewer-but-better hits.
 */

export interface AssetSearchResult {
    name: string;
    path: string;
    category: string;
    pack: string;
    /** Canonical size [W, H, D] in meters after MODEL_FACING.json scaling. */
    size?: [number, number, number];
    vertices?: number;
    /** Free-text description shown alongside path in search_assets.sh
     *  output. Used for community assets where the path token is opaque
     *  and the only readable label is the original generation prompt. */
    description?: string;
}

export interface AssetSearchOpts {
    query: string;
    category?: string;
    limit: number;
    /** Set when the request includes an X-User-Id header (preview UI uses
     *  this; sandbox runs don't have user identity at search time). When
     *  set, extensions can include the user's own private assets. */
    userId?: number | null;
}

type ExtensionFn = (opts: AssetSearchOpts) => Promise<AssetSearchResult[]>;

const extensions: ExtensionFn[] = [];

export function registerAssetSearchExtension(fn: ExtensionFn): void {
    extensions.push(fn);
}

export async function runAssetSearchExtensions(opts: AssetSearchOpts): Promise<AssetSearchResult[]> {
    if (extensions.length === 0) return [];
    const results: AssetSearchResult[] = [];
    // Run in parallel — extensions are independent.
    const settled = await Promise.allSettled(extensions.map(fn => fn(opts)));
    for (const r of settled) {
        if (r.status === 'fulfilled') results.push(...r.value);
        else console.error('[asset_search_extensions] extension threw:', r.reason);
    }
    return results;
}
