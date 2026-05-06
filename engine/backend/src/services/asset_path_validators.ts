/**
 * Plugin-side extensions to /api/engine/internal/validate-asset-paths.
 *
 * Symmetric to asset_search_extensions: that one *surfaces* AI-generated
 * GLBs in search results, this one *validates* that a given path is real
 * before the AI's edit / sandbox-build commits. Without this, validate.sh
 * and EDIT-block commit would still treat /assets/generated/<token>.glb
 * as good as long as the token shape is well-formed — even when the
 * token was hallucinated by the LLM and doesn't exist in any DB row.
 *
 * Pattern:
 *   - Plugin's onStartup calls registerAssetPathValidator(fn).
 *   - Each validator inspects the candidate path list and returns the
 *     subset it KNOWS about + accepts. Anything left out by every
 *     validator AND not in the engine's pack catalog is reported as
 *     missing.
 *   - Validators MUST be safe under concurrent calls and MUST NOT throw
 *     (log + return empty on failure — a flaky validator should not
 *     gate a build on its own).
 *
 * Validator contract:
 *   input  — { paths: string[], userId: number | null }
 *   output — { recognized: string[] }   subset of `paths` the validator
 *                                       claims as real + accessible to
 *                                       this user. Paths the validator
 *                                       doesn't know about (e.g. pack
 *                                       paths arriving at a model_gen
 *                                       validator) are simply omitted.
 */

export interface AssetPathValidationOpts {
    paths: string[];
    /** Set when the request includes an X-User-Id header (FIX_GAME /
     *  CREATE_GAME via .search_config.json, chat AI via the WS user
     *  binding). Plugins use it to admit the user's own private
     *  assets that aren't yet public. */
    userId: number | null;
}

export interface AssetPathValidationResult {
    /** Paths that this validator confirms exist AND the requesting user
     *  is allowed to reference. Subset of `opts.paths`. */
    recognized: string[];
}

type ValidatorFn = (opts: AssetPathValidationOpts) => Promise<AssetPathValidationResult>;

const validators: ValidatorFn[] = [];

export function registerAssetPathValidator(fn: ValidatorFn): void {
    validators.push(fn);
}

/** Run every registered validator and union their `recognized` outputs.
 *  A path is recognized if ANY validator claims it. */
export async function runAssetPathValidators(opts: AssetPathValidationOpts): Promise<Set<string>> {
    if (validators.length === 0 || opts.paths.length === 0) return new Set();
    const recognized = new Set<string>();
    const settled = await Promise.allSettled(validators.map(fn => fn(opts)));
    for (const s of settled) {
        if (s.status === 'fulfilled') {
            for (const p of s.value.recognized) recognized.add(p);
        } else {
            console.error('[asset_path_validators] validator threw:', s.reason);
        }
    }
    return recognized;
}
