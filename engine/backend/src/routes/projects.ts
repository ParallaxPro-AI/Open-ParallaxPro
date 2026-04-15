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

let _plugins: EnginePlugin[] = [];
export function setProjectPlugins(plugins: EnginePlugin[]) { _plugins = plugins; }

const __dirname_proj = path.dirname(fileURLToPath(import.meta.url));
const FEEDBACKS_DIR = path.resolve(__dirname_proj, '../../feedbacks');
if (!fs.existsSync(FEEDBACKS_DIR)) fs.mkdirSync(FEEDBACKS_DIR, { recursive: true });

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 5 },
    fileFilter: (_req, file, cb) => {
        cb(null, file.mimetype.startsWith('image/'));
    },
});

const router = Router();
router.use(requireAuth);

// `has_files` checks for the new file-tree shape (post template-unification migration).
// Legacy projects carry the old `{scenes, scripts, uiFiles}` blob and need an older
// build of the engine to open. We only sniff the first 500 chars to keep the list
// query cheap.
const stmtList = db.prepare(`SELECT id, name, thumbnail, status, created_at, updated_at,
    instr(substr(project_data, 1, 500), '"files"') AS has_files
    FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`);
const stmtGet = db.prepare('SELECT * FROM projects WHERE id = ?');
const stmtInsert = db.prepare('INSERT INTO projects (id, user_id, name, project_data) VALUES (?, ?, ?, ?)');
const stmtUpdate = db.prepare('UPDATE projects SET name = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?');
const stmtUpdateData = db.prepare('UPDATE projects SET project_data = ?, updated_at = datetime(\'now\') WHERE id = ?');
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
            // Fallback to substring match
            const q = search.toLowerCase();
            const filtered = catalog.filter(t =>
                t.name.toLowerCase().includes(q) || t.id.includes(q) || t.description.toLowerCase().includes(q)
            );
            res.json({ templates: filtered.length > 0 ? filtered : catalog });
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

router.post('/', async (req, res) => {
    const id = randomUUID();
    const { templateId, prompt } = req.body || {};

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
    });
});

// Update project name
router.put('/:id', (req, res) => {
    const result = stmtUpdate.run(req.body.name || 'Untitled Project', req.params.id, req.user!.id);
    if (result.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ success: true });
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
