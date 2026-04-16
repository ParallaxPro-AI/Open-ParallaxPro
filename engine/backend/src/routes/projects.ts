import { Router } from 'express';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import db from '../db/connection.js';
import type { EnginePlugin } from '../plugin.js';
import {
    parseProjectData,
    serializeProjectData,
    isLegacyProjectData,
} from '../ws/services/pipeline/project_files.js';
import { seedFromTemplate, seedEmpty } from '../ws/services/pipeline/project_seeder.js';
import { buildProject, cleanupBuildDir } from '../ws/services/pipeline/project_builder.js';
import { applyIncomingFile } from '../ws/services/pipeline/project_save.js';
import { generateProjectName } from '../ws/services/llm.js';
import { broadcastProjectRenamed } from '../ws/editor_ws.js';
import { tryConsumeEmbedBudget } from '../middleware/embed_rate_limit.js';

let _plugins: EnginePlugin[] = [];
export function setProjectPlugins(plugins: EnginePlugin[]) { _plugins = plugins; }

const __dirname_proj = path.dirname(fileURLToPath(import.meta.url));
const FEEDBACKS_DIR = path.resolve(__dirname_proj, '../../feedbacks');
if (!fs.existsSync(FEEDBACKS_DIR)) fs.mkdirSync(FEEDBACKS_DIR, { recursive: true });

// Project card thumbnails. Shared with the hosted publish plugin's
// THUMBNAIL_DIR — same on-disk dir — so uploads from the local OSS
// backend and uploads from the hosted publish flow co-exist cleanly.
export const THUMBNAIL_DIR = path.resolve(__dirname_proj, '../../uploads/thumbnails');
if (!fs.existsSync(THUMBNAIL_DIR)) fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 5 },
    fileFilter: (_req, file, cb) => {
        cb(null, file.mimetype.startsWith('image/'));
    },
});

const thumbnailUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        cb(null, ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.mimetype));
    },
});

const router = Router();
router.use(requireAuth);

// `has_files` checks for the new file-tree shape (post template-unification migration).
// Legacy projects carry the old `{scenes, scripts, uiFiles}` blob and need an older
// build of the engine to open. We only sniff the first 500 chars to keep the list
// query cheap.
const stmtList = db.prepare(`SELECT id, name, thumbnail, status, created_at, updated_at,
    is_cloud, cloud_user_id, cloud_pulled_updated_at, edited_engine_hash,
    instr(substr(project_data, 1, 500), '"files"') AS has_files
    FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`);
const stmtGet = db.prepare('SELECT * FROM projects WHERE id = ?');
const stmtInsert = db.prepare('INSERT INTO projects (id, user_id, name, project_data) VALUES (?, ?, ?, ?)');
const stmtUpdate = db.prepare(`UPDATE projects SET name = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ? AND user_id = ?`);
const stmtUpdateData = db.prepare(`UPDATE projects SET project_data = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?`);
const stmtDelete = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?');

// List projects
router.get('/', (req, res) => {
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(100, parseInt(req.query.limit as string) || 100);
    const offset = (page - 1) * limit;
    const rows = stmtList.all(req.user!.id, limit, offset) as any[];
    const projects = rows.map(r => ({
        id: r.id,
        name: r.name,
        thumbnail: r.thumbnail,
        status: r.status,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        legacy: !r.has_files,
        isCloud: !!r.is_cloud,
        cloudUserId: r.cloud_user_id,
        cloudPulledUpdatedAt: r.cloud_pulled_updated_at,
        editedEngineHash: r.edited_engine_hash,
    }));
    res.json({ projects });
});

// List available game templates (with optional semantic search)
router.get('/templates', async (req, res) => {
    try {
        const { loadTemplateCatalog } = await import('../ws/services/pipeline/template_loader.js');
        const catalog = loadTemplateCatalog();
        const search = (req.query.search as string || '').trim();

        if (!search) {
            res.json({ templates: catalog });
            return;
        }

        // Helper: substring match fallback, used on budget-exhaustion or error.
        const substringMatch = () => {
            const q = search.toLowerCase();
            const filtered = catalog.filter(t =>
                t.name.toLowerCase().includes(q) || t.id.includes(q) || t.description.toLowerCase().includes(q)
            );
            res.json({ templates: filtered.length > 0 ? filtered : catalog });
        };

        // Gate embedding search on per-user budget (hosted only).
        if (!tryConsumeEmbedBudget(req.user?.id)) {
            substringMatch();
            return;
        }

        // Semantic search using embedding model
        try {
            const { embedText, cosineSimilarity } = await import('../embedding_service.js');
            const queryVec = await embedText(search);
            const scored: { template: any; score: number }[] = [];
            for (const t of catalog) {
                const text = `${t.name} ${t.description} ${t.id.replace(/_/g, ' ')}`;
                const tVec = await embedText(text);
                scored.push({ template: t, score: cosineSimilarity(queryVec, tVec) });
            }
            scored.sort((a, b) => b.score - a.score);
            res.json({ templates: scored.map(s => s.template) });
        } catch {
            substringMatch();
        }
    } catch (e: any) {
        res.json({ templates: [] });
    }
});

// Create project
const stmtUserProjectNames = db.prepare('SELECT name FROM projects WHERE user_id = ?');
const stmtUserProjectNamesExcept = db.prepare('SELECT name FROM projects WHERE user_id = ? AND id != ?');

/**
 * Pick the smallest N >= 1 such that `${base}-${N}` isn't already a project
 * name for this user. Used for both the default `project-N` names and the
 * template-derived `fps_shooter-N` names.
 */
function nextCountedName(userId: number, base: string): string {
    const rows = stmtUserProjectNames.all(userId) as { name: string }[];
    const taken = new Set(rows.map(r => r.name));
    let i = 1;
    while (taken.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
}

/**
 * Resolve a preferred name against a user's existing projects. Returns the
 * preferred name unchanged if free, otherwise appends `-2`, `-3`, … until
 * unique. `excludeId` lets the caller ignore the project being renamed.
 */
function resolveUniqueName(userId: number, preferred: string, excludeId?: string): string {
    const rows = (excludeId
        ? stmtUserProjectNamesExcept.all(userId, excludeId)
        : stmtUserProjectNames.all(userId)) as { name: string }[];
    const taken = new Set(rows.map(r => r.name));
    if (!taken.has(preferred)) return preferred;
    let i = 2;
    while (taken.has(`${preferred}-${i}`)) i++;
    return `${preferred}-${i}`;
}

const MAX_PROMPT_CHARS = 2500;

router.post('/', async (req, res) => {
    const id = randomUUID();
    const { templateId, prompt } = req.body || {};

    if (typeof prompt === 'string' && prompt.length > MAX_PROMPT_CHARS) {
        res.status(400).json({ error: `Prompt exceeds ${MAX_PROMPT_CHARS} characters.` });
        return;
    }

    const seed = templateId ? seedFromTemplate(templateId) : seedEmpty();
    if (seed.warnings.length > 0) {
        for (const w of seed.warnings) console.warn(`[Projects] Seed warning for "${id}": ${w}`);
    }

    // Template flow gets a name derived from the template id; prompt and
    // empty flows start with the generic `project-N`. The prompt flow upgrades
    // the name asynchronously below once the LLM responds.
    const baseName = templateId || 'project';
    const name = nextCountedName(req.user!.id, baseName);
    const projectData = { projectConfig: { name }, files: seed.files };

    stmtInsert.run(id, req.user!.id, name, serializeProjectData(projectData));
    for (const p of _plugins) { if (p.onProjectCreate) p.onProjectCreate(id, req.user!.id, req.user!.username ?? null); }

    res.json({ id, name });

    if (typeof prompt === 'string' && prompt.trim() && !templateId) {
        renameFromPromptAsync(id, req.user!.id, prompt, name).catch(e => {
            console.warn(`[Projects] async rename failed for ${id}:`, e?.message ?? e);
        });
    }
});

/**
 * Fire-and-forget: ask the LLM for a short kebab-case name, resolve any
 * conflict with the user's existing project names, write it to the DB +
 * project_data, and push a `project_renamed` event to any open editor tabs.
 * Silently gives up if the LLM times out or returns nothing usable — the
 * initial `project-N` name just stays.
 */
async function renameFromPromptAsync(projectId: string, userId: number, prompt: string, initialName: string): Promise<void> {
    const generated = await generateProjectName(prompt, 10000);
    if (!generated) return;

    const row = stmtGet.get(projectId) as any;
    if (!row || row.user_id !== userId) return;

    // If the user already renamed the project while the LLM was thinking,
    // respect their choice and bail out — don't clobber with the auto-name.
    if (row.name !== initialName) return;

    const finalName = resolveUniqueName(userId, generated, projectId);

    let newProjectDataJson: string | null = null;
    try {
        const data = parseProjectData(row.project_data);
        if (!isLegacyProjectData(data) && data.projectConfig) {
            data.projectConfig.name = finalName;
            newProjectDataJson = serializeProjectData(data);
        }
    } catch { /* leave project_data untouched on parse failure */ }

    const tx = db.transaction(() => {
        stmtUpdate.run(finalName, projectId, userId);
        if (newProjectDataJson) stmtUpdateData.run(newProjectDataJson, projectId);
    });
    tx();

    broadcastProjectRenamed(projectId, finalName);
}

// Get project — builds the project from its file tree on each load.
router.get('/:id', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    const data = parseProjectData(row.project_data);
    if (isLegacyProjectData(data)) {
        res.status(409).json({ error: 'This project was created before the file-tree migration. Please delete and recreate it.' });
        return;
    }

    const built = buildProject(row.id, data.files);
    if (!built.success) {
        res.status(500).json({ error: `Failed to build project: ${built.error}` });
        return;
    }

    res.json({
        id: row.id,
        name: row.name,
        thumbnail: row.thumbnail,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        projectConfig: data.projectConfig,
        files: data.files,
        scenes: built.scenes,
        scripts: built.scripts,
        uiFiles: built.uiFiles,
        sourceMap: built.sourceMap,
        multiplayerConfig: built.multiplayerConfig,
        editor: extractEditorFiles(data.files),
        isCloud: !!row.is_cloud,
        cloudUserId: row.cloud_user_id,
        cloudPulledUpdatedAt: row.cloud_pulled_updated_at,
        editedEngineHash: row.edited_engine_hash,
    });
});

// Update project name
router.put('/:id', (req, res) => {
    const result = stmtUpdate.run(req.body.name || 'Untitled Project', req.params.id, req.user!.id);
    if (result.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
    const row = stmtGet.get(req.params.id) as any;
    res.json({ success: true, updatedAt: row?.updated_at });
});

// Save project files — accepts template paths, scene snapshots (translated into
// placement edits), editor metadata, and assembled-script keys (routed via
// the build's source map).
router.put('/:id/files', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    const data = parseProjectData(row.project_data);
    if (isLegacyProjectData(data)) {
        res.status(409).json({ error: 'Legacy project — please recreate it.' });
        return;
    }

    const incoming = req.body.files || {};
    for (const [filePath, content] of Object.entries(incoming)) {
        const result = applyIncomingFile(data, row.id, filePath, content);
        if (result.error) console.warn(`[Projects] file_save "${filePath}": ${result.error}`);
    }

    stmtUpdateData.run(serializeProjectData(data), req.params.id);
    res.json({ success: true });
});

// Delete project
router.delete('/:id', (req, res) => {
    const result = stmtDelete.run(req.params.id, req.user!.id);
    if (result.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
    cleanupBuildDir(req.params.id);
    for (const p of _plugins) { if (p.onProjectDelete) p.onProjectDelete(req.params.id, req.user!.id); }
    res.json({ success: true });
});

// Duplicate project
router.post('/:id/duplicate', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    const newId = randomUUID();
    const newName = `${row.name} (copy)`;
    stmtInsert.run(newId, req.user!.id, newName, row.project_data);

    res.json({ id: newId, name: newName });
});

export { stmtGet, stmtUpdateData };

// Replace the entire project_data blob. Used by self-hosted Checkout
// flows to revert local source to a previously-published version's
// frozen tree (fetched from parallaxpro.ai). Intentionally distinct
// from PUT /:id/files — which merges per-file via applyIncomingFile
// and would leave any files present locally but absent in the target
// version still hanging around.
router.post('/:id/replace-project-data', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    const { projectConfig, files } = req.body;
    if (!files || typeof files !== 'object') {
        res.status(400).json({ error: 'files required' });
        return;
    }
    const next = { projectConfig: projectConfig || { name: row.name }, files };
    stmtUpdateData.run(JSON.stringify(next), req.params.id);
    res.json({ success: true });
});

// ── Cloud sync (local side) ──
// cloud-pull upserts a project row with data that came from prod,
// flips is_cloud=1 and stamps the sync-state columns so the next
// save can issue a matching expectedUpdatedAt on push.
router.post('/:id/cloud-pull', (req, res) => {
    const { name, projectConfig, files, thumbnail, cloudUpdatedAt, cloudUserId, editedEngineHash } = req.body;
    if (!name || !files || typeof files !== 'object' || !cloudUpdatedAt || typeof cloudUserId !== 'number') {
        res.status(400).json({ error: 'name, files, cloudUpdatedAt, and cloudUserId are required.' });
        return;
    }
    const data = JSON.stringify({ projectConfig: projectConfig || { name }, files });
    const existing = stmtGet.get(req.params.id) as any;
    // Set updated_at to the remote's timestamp so a just-pulled row
    // compares as 'synced' (localT === cloudPulledUpdatedAt) instead of
    // 'local-newer' — which is what would happen if we stamped "now"
    // (the pull would always look like an unsynced edit).
    if (existing) {
        if (existing.user_id !== req.user!.id) {
            res.status(403).json({ error: 'Project is owned by a different local user.' });
            return;
        }
        db.prepare(`
            UPDATE projects
            SET name = ?, project_data = ?, thumbnail = ?, is_cloud = 1,
                cloud_user_id = ?, cloud_pulled_updated_at = ?, edited_engine_hash = ?,
                updated_at = ?
            WHERE id = ?
        `).run(name, data, thumbnail ?? null, cloudUserId, cloudUpdatedAt, editedEngineHash ?? null, cloudUpdatedAt, req.params.id);
    } else {
        db.prepare(`
            INSERT INTO projects (
                id, user_id, name, project_data, thumbnail,
                is_cloud, cloud_user_id, cloud_pulled_updated_at, edited_engine_hash,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
        `).run(req.params.id, req.user!.id, name, data, thumbnail ?? null, cloudUserId, cloudUpdatedAt, editedEngineHash ?? null, cloudUpdatedAt);
    }
    res.json({ success: true });
});

// mark-cloud is the lighter-weight pair to cloud-pull — used by the
// push path to record "this project is now cloud, last known prod
// updated_at is X" without rewriting project_data. Also used by the
// Promote to Cloud prompt after a one-off cloud-upsert.
router.post('/:id/mark-cloud', (req, res) => {
    const { cloudUserId, cloudUpdatedAt, editedEngineHash, thumbnail } = req.body;
    if (typeof cloudUserId !== 'number' || !cloudUpdatedAt) {
        res.status(400).json({ error: 'cloudUserId and cloudUpdatedAt are required.' });
        return;
    }
    const existing = stmtGet.get(req.params.id) as any;
    if (!existing) { res.status(404).json({ error: 'Project not found' }); return; }
    if (existing.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }
    db.prepare(`
        UPDATE projects
        SET is_cloud = 1, cloud_user_id = ?, cloud_pulled_updated_at = ?,
            edited_engine_hash = COALESCE(?, edited_engine_hash),
            thumbnail = COALESCE(?, thumbnail)
        WHERE id = ?
    `).run(cloudUserId, cloudUpdatedAt, editedEngineHash ?? null, thumbnail ?? null, req.params.id);
    res.json({ success: true });
});

// Upload a project thumbnail. Writes to uploads/thumbnails/<id>.<ext>
// and stores the relative URL on the row. Hosted deployments also run
// the publish plugin's /thumbnail route against the same dir — they
// co-exist because URLs end up the same. For cloud projects on self-
// hosted, the client is responsible for mirroring the upload to prod
// via cloud-thumbnail so other machines see the new image too.
router.post('/:id/thumbnail', thumbnailUpload.single('thumbnail'), (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }
    if (!req.file) { res.status(400).json({ error: 'No valid image file provided.' }); return; }

    const ext = path.extname(req.file.originalname).toLowerCase() || '.png';
    const filename = `${req.params.id}${ext}`;
    try {
        fs.writeFileSync(path.join(THUMBNAIL_DIR, filename), req.file.buffer);
    } catch (e: any) {
        res.status(500).json({ error: `Failed to persist thumbnail: ${e.message}` });
        return;
    }
    const thumbnailUrl = `/uploads/thumbnails/${filename}`;
    db.prepare(`UPDATE projects SET thumbnail = ?, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ? AND user_id = ?`)
        .run(thumbnailUrl, req.params.id, req.user!.id);
    const fresh = stmtGet.get(req.params.id) as any;
    res.json({ success: true, thumbnail: thumbnailUrl, updatedAt: fresh?.updated_at });
});

router.delete('/:id/thumbnail', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    if (row.thumbnail) {
        const filePath = path.join(THUMBNAIL_DIR, path.basename(row.thumbnail));
        try { fs.unlinkSync(filePath); } catch {}
    }
    db.prepare(`UPDATE projects SET thumbnail = NULL, updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ? AND user_id = ?`)
        .run(req.params.id, req.user!.id);
    const fresh = stmtGet.get(req.params.id) as any;
    res.json({ success: true, updatedAt: fresh?.updated_at });
});

// Explicit unmark (used by "Delete, keep cloud copy" choice).
router.post('/:id/unmark-cloud', (req, res) => {
    const existing = stmtGet.get(req.params.id) as any;
    if (!existing) { res.status(404).json({ error: 'Project not found' }); return; }
    if (existing.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }
    db.prepare(`UPDATE projects SET is_cloud = 0, cloud_user_id = NULL, cloud_pulled_updated_at = NULL WHERE id = ?`)
        .run(req.params.id);
    res.json({ success: true });
});
// Submit feedback with optional image uploads
router.post('/:id/feedback', upload.array('images', 5), (req, res) => {
    const message = req.body.message;
    if (!message || typeof message !== 'string') {
        res.status(400).json({ error: 'Message is required' });
        return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const feedbackDir = path.join(FEEDBACKS_DIR, `${timestamp}_u${req.user!.id}_p${req.params.id.slice(0, 8)}`);
    fs.mkdirSync(feedbackDir, { recursive: true });

    // Save message
    fs.writeFileSync(path.join(feedbackDir, 'message.txt'), `User: ${req.user!.username} (id: ${req.user!.id})\nProject: ${req.params.id}\nTime: ${new Date().toISOString()}\n\n${message}`);

    // Save images
    const files = req.files as Express.Multer.File[];
    if (files && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
            const ext = path.extname(files[i].originalname) || '.png';
            fs.writeFileSync(path.join(feedbackDir, `image_${i + 1}${ext}`), files[i].buffer);
        }
    }

    console.log(`[Feedback] Saved to ${feedbackDir} (${files?.length || 0} images)`);
    res.json({ success: true });
});

/**
 * Pull `editor/*` files out of the file tree and parse them, so the frontend
 * can read them via `pd.editor['editor/camera.json']` etc. (matches the legacy
 * shape the editor was already coded against).
 */
function extractEditorFiles(files: Record<string, string>): Record<string, any> {
    const out: Record<string, any> = {};
    for (const [path, content] of Object.entries(files)) {
        if (!path.startsWith('editor/')) continue;
        try { out[path] = JSON.parse(content); } catch { out[path] = content; }
    }
    return out;
}

export default router;
