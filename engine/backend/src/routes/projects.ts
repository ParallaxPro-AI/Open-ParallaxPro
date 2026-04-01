import { Router } from 'express';
import { randomUUID } from 'crypto';
import { requireAuth } from '../middleware/auth.js';
import db from '../db/connection.js';

const router = Router();
router.use(requireAuth);

const stmtList = db.prepare('SELECT id, name, thumbnail, status, created_at, updated_at FROM projects WHERE user_id = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?');
const stmtGet = db.prepare('SELECT * FROM projects WHERE id = ?');
const stmtInsert = db.prepare('INSERT INTO projects (id, user_id, name, project_data) VALUES (?, ?, ?, ?)');
const stmtUpdate = db.prepare('UPDATE projects SET name = ?, updated_at = datetime(\'now\') WHERE id = ? AND user_id = ?');
const stmtUpdateData = db.prepare('UPDATE projects SET project_data = ?, updated_at = datetime(\'now\') WHERE id = ?');
const stmtDelete = db.prepare('DELETE FROM projects WHERE id = ? AND user_id = ?');

const DEFAULT_PROJECT_DATA = JSON.stringify({
    projectConfig: { name: 'Untitled Project' },
    scenes: {
        'main.json': {
            id: 1,
            name: 'Main',
            entities: [
                {
                    id: 1, name: 'Main Camera', tags: [],
                    components: [
                        { type: 'TransformComponent', data: { position: { x: 0, y: 3, z: 5 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                        { type: 'CameraComponent', data: { mode: 0, fov: 60, nearClip: 0.1, farClip: 1000, priority: 0 } },
                    ],
                },
                {
                    id: 2, name: 'Directional Light', tags: [],
                    components: [
                        { type: 'TransformComponent', data: { position: { x: 0, y: 10, z: 0 }, rotation: { x: -0.3, y: 0.5, z: 0, w: 0.85 }, scale: { x: 1, y: 1, z: 1 } } },
                        { type: 'LightComponent', data: { lightType: 0, color: { r: 1, g: 0.95, b: 0.9, a: 1 }, intensity: 1.0 } },
                    ],
                },
                {
                    id: 3, name: 'Ground Plane', tags: [],
                    components: [
                        { type: 'TransformComponent', data: { position: { x: 0, y: -0.5, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 100, y: 1, z: 100 } } },
                        { type: 'MeshRendererComponent', data: { meshType: 'cube', materialOverrides: { baseColor: [0.3, 0.35, 0.3, 1] } } },
                        { type: 'ColliderComponent', data: { shapeType: 0, size: { x: 1, y: 1, z: 1 } } },
                        { type: 'RigidbodyComponent', data: { mass: 0, bodyType: 'static' } },
                    ],
                },
            ],
            environment: {
                ambientColor: [1, 1, 1],
                ambientIntensity: 0.3,
                fog: { enabled: false, color: [0.8, 0.8, 0.8], near: 10, far: 100 },
                gravity: [0, -9.81, 0],
                timeOfDay: 12,
                dayNightCycleSpeed: 0,
            },
        },
    },
    scripts: {},
    uiFiles: {},
});

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
    }));
    res.json({ projects });
});

// Create project
router.post('/', (req, res) => {
    const id = randomUUID();
    const name = req.body.name || 'Untitled Project';

    const projectData = JSON.parse(DEFAULT_PROJECT_DATA);
    projectData.projectConfig.name = name;

    stmtInsert.run(id, req.user!.id, name, JSON.stringify(projectData));

    res.json({ id, name });
});

// Get project
router.get('/:id', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    const projectData = row.project_data ? JSON.parse(row.project_data) : {};
    res.json({
        id: row.id,
        name: row.name,
        thumbnail: row.thumbnail,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        ...projectData,
    });
});

// Update project name
router.put('/:id', (req, res) => {
    const result = stmtUpdate.run(req.body.name || 'Untitled Project', req.params.id, req.user!.id);
    if (result.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
    res.json({ success: true });
});

// Save project files
router.put('/:id/files', (req, res) => {
    const row = stmtGet.get(req.params.id) as any;
    if (!row) { res.status(404).json({ error: 'Project not found' }); return; }
    if (row.user_id !== req.user!.id) { res.status(403).json({ error: 'Access denied' }); return; }

    const projectData = row.project_data ? JSON.parse(row.project_data) : {};
    const files = req.body.files || {};

    for (const [path, content] of Object.entries(files)) {
        if (path === 'projectConfig') {
            projectData.projectConfig = content;
        } else if (path.startsWith('scenes/')) {
            if (!projectData.scenes) projectData.scenes = {};
            projectData.scenes[path.replace('scenes/', '')] = content;
        } else if (path.startsWith('scripts/')) {
            if (!projectData.scripts) projectData.scripts = {};
            projectData.scripts[path.replace('scripts/', '')] = content;
        } else if (path.startsWith('uiFiles/')) {
            if (!projectData.uiFiles) projectData.uiFiles = {};
            projectData.uiFiles[path.replace('uiFiles/', '')] = content;
        }
    }

    stmtUpdateData.run(JSON.stringify(projectData), req.params.id);
    res.json({ success: true });
});

// Delete project
router.delete('/:id', (req, res) => {
    const result = stmtDelete.run(req.params.id, req.user!.id);
    if (result.changes === 0) { res.status(404).json({ error: 'Project not found' }); return; }
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
export default router;
