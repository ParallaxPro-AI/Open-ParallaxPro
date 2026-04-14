/**
 * project_save.ts — shared helper for routing incoming file_save payloads from
 * the editor (REST PUT /:id/files or WS file_save / project_save) into the
 * project's file tree.
 *
 * Scene snapshots (`scenes/X.json` — the assembled scene the editor just
 * modified) get translated into placement edits in `03_worlds.json` via
 * applySceneSnapshot. Editor metadata (`editor/...`) is stored verbatim.
 * Template paths (01-04 JSON, behaviors/, systems/, ui/) and assembled-script
 * keys (routed via the build's source map) write through directly.
 */

import { ProjectData, setFile } from './project_files.js';
import { buildProject } from './project_builder.js';
import { applySceneSnapshot } from './template_mutator.js';

export interface SaveOutcome {
    error?: string;
    /** True when the change can produce assembly output the user hasn't already
     *  applied locally — i.e. a template/source edit, not a scene snapshot. */
    shouldRebuildAndPush: boolean;
}

/**
 * Apply one incoming file save into `pd`'s file tree. `projectId` is used only
 * to key the build's temp dir when we need the source map; it does not need to
 * match the project's real id (a stable string per call site is fine).
 */
export function applyIncomingFile(
    pd: ProjectData,
    projectId: string,
    filePath: string,
    content: any,
): SaveOutcome {
    if (filePath === 'projectConfig' || filePath === 'project.json') {
        if (content && typeof content === 'object') pd.projectConfig = content as { name: string };
        return { shouldRebuildAndPush: false };
    }

    if (filePath.startsWith('scenes/')) {
        const sceneJson = typeof content === 'string' ? safeParse(content) : content;
        if (!sceneJson) return { error: 'Scene save body was not valid JSON.', shouldRebuildAndPush: false };
        const applied = applySceneSnapshot(pd.files, sceneJson);
        if (applied.warnings.length > 0) {
            for (const w of applied.warnings) console.warn(`[file_save ${filePath}] ${w}`);
        }
        for (const [k, v] of Object.entries(applied.updatedFiles)) setFile(pd, k, v);
        return { shouldRebuildAndPush: false };
    }

    if (filePath.startsWith('editor/')) {
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        setFile(pd, filePath, text);
        return { shouldRebuildAndPush: false };
    }

    let target: string | null = filePath;
    if (filePath.startsWith('scripts/') || filePath.startsWith('uiFiles/')) {
        const built = buildProject(projectId, pd.files);
        target = resolveSavePath(filePath, built.sourceMap);
    } else {
        target = resolveSavePath(filePath, {});
    }
    if (!target) {
        return { error: `Path "${filePath}" is not editable in the file tree.`, shouldRebuildAndPush: false };
    }
    const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    setFile(pd, target, text);
    return { shouldRebuildAndPush: true };
}

/** Map an incoming file_save path to a template-file path in the project tree. */
export function resolveSavePath(incomingPath: string, sourceMap: Record<string, string>): string | null {
    if (incomingPath.endsWith('.json') && /^0\d_/.test(incomingPath)) return incomingPath;
    if (incomingPath.startsWith('behaviors/')) return incomingPath;
    if (incomingPath.startsWith('systems/')) return incomingPath;
    if (incomingPath.startsWith('scripts/')) return sourceMap[incomingPath] || incomingPath;
    if (incomingPath.startsWith('ui/')) return incomingPath;
    if (incomingPath.startsWith('uiFiles/')) {
        const ui = `ui/${incomingPath.slice('uiFiles/'.length)}`;
        return sourceMap[ui] || ui;
    }
    return null;
}

function safeParse(s: string): any | null {
    try { return JSON.parse(s); } catch { return null; }
}
