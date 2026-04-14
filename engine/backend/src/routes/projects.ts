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
    defaultProjectData,
    setFile,
} from '../ws/services/pipeline/project_files.js';
import { seedFromTemplate, seedEmpty } from '../ws/services/pipeline/project_seeder.js';
import { buildProject, cleanupBuildDir } from '../ws/services/pipeline/project_builder.js';

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
const stmtCountProjects = db.prepare('SELECT COUNT(*) as count FROM projects WHERE user_id = ?');

router.post('/', async (req, res) => {
    const id = randomUUID();
    const count = (stmtCountProjects.get(req.user!.id) as any).count;
    const name = `project-${count + 1}`;
    const { templateId } = req.body || {};

    const seed = templateId ? seedFromTemplate(templateId) : seedEmpty();
    if (seed.warnings.length > 0) {
        for (const w of seed.warnings) console.warn(`[Projects] Seed warning for "${id}": ${w}`);
    }
    const projectData = { projectConfig: { name }, files: seed.files };

    stmtInsert.run(id, req.user!.id, name, serializeProjectData(projectData));

    res.json({ id, name });
});

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
    });
});

// Update project name
router.put('/:id', (req, res) => {
    const result = stmtUpdate.run(req.body.name || 'Untitled Project', req.params.id, req.user!.id);
    if (result.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ success: true });
});

// Save project files — accepts template file paths (01_flow.json, behaviors/...,
// systems/..., ui/..., scripts/...) and routes legacy assembled keys via sourceMap.
router.put('/:id/files', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    const data = parseProjectData(row.project_data);
    if (isLegacyProjectData(data)) {
        res.status(409).json({ error: 'Legacy project — please recreate it.' });
        return;
    }
    const built = buildProject(row.id, data.files);

    const incoming = req.body.files || {};
    for (const [filePath, content] of Object.entries(incoming)) {
        if (filePath === 'projectConfig') {
            data.projectConfig = content as { name: string };
            continue;
        }
        const target = resolveSavePath(filePath, built.sourceMap);
        if (!target) {
            console.warn(`[Projects] Ignored file_save for unmapped path "${filePath}"`);
            continue;
        }
        setFile(data, target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    }

    stmtUpdateData.run(serializeProjectData(data), req.params.id);
    res.json({ success: true });
});

/** Map an incoming file_save path to a template-file path in the project tree. */
function resolveSavePath(incomingPath: string, sourceMap: Record<string, string>): string | null {
    // Already a template path? (01_flow.json, 02_entities.json, behaviors/*, systems/*, scripts/*, ui/*)
    if (incomingPath.endsWith('.json') && /^0\d_/.test(incomingPath)) return incomingPath;
    if (incomingPath.startsWith('behaviors/')) return incomingPath;
    if (incomingPath.startsWith('systems/')) return incomingPath;
    if (incomingPath.startsWith('scripts/')) {
        // Assembled script key — look up source. If unmapped, treat as a user script.
        return sourceMap[incomingPath] || incomingPath;
    }
    if (incomingPath.startsWith('ui/')) return incomingPath;
    if (incomingPath.startsWith('uiFiles/')) {
        const ui = `ui/${incomingPath.slice('uiFiles/'.length)}`;
        return sourceMap[ui] ? sourceMap[ui] : ui;
    }
    if (incomingPath.startsWith('scenes/')) return null; // assembled, can't round-trip
    return null;
}

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

export default router;
