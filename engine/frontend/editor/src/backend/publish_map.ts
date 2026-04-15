/**
 * Bookkeeping for self-hosted → parallaxpro.ai publish mappings.
 *
 * Each local project that has ever been published to parallaxpro.ai has
 * an entry here linking the local project id to the hosted "shadow"
 * project id (plus the owner + slug for display). Used by:
 *   - toolbar.ts publish flow: listVersionsProd, setLiveVersionProd,
 *     unpublishProd, checkout.
 *   - project_list_view.ts: cross-ref local projects with prod publish
 *     info so cards show PUBLISHED vX.Y badges + thumbnails.
 */

export const PUBLISH_MAP_KEY = 'ppl_publish_map_v1';

export interface PublishMapEntry {
    prodProjectId: string;
    owner: string;
    slug: string;
}

export function readPublishMap(): Record<string, PublishMapEntry> {
    try {
        const raw = localStorage.getItem(PUBLISH_MAP_KEY);
        return raw ? (JSON.parse(raw) || {}) : {};
    } catch {
        return {};
    }
}

export function writePublishMapEntry(localProjectId: string, entry: PublishMapEntry): void {
    const map = readPublishMap();
    map[localProjectId] = entry;
    try { localStorage.setItem(PUBLISH_MAP_KEY, JSON.stringify(map)); } catch {}
}

export function deletePublishMapEntry(localProjectId: string): void {
    const map = readPublishMap();
    delete map[localProjectId];
    try { localStorage.setItem(PUBLISH_MAP_KEY, JSON.stringify(map)); } catch {}
}
