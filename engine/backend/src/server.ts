import express from 'express';
import cors from 'cors';
import http from 'http';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import db from './db/connection.js';
import { createSchema } from './db/schema.js';

// Initialize database before importing routes (they prepare statements at import time)
createSchema(db);

const { default: projectRoutes } = await import('./routes/projects.js');
const { default: assetRoutes } = await import('./routes/assets.js');
const { setupEditorWebSocket } = await import('./ws/editor_ws.js');

// Express app
const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Static asset serving
app.use('/assets', express.static(config.assetsDir, { maxAge: '1y', immutable: true }));

// Routes
app.use('/api/engine/projects', projectRoutes);
app.use('/api/engine/assets', assetRoutes);

app.get('/api/engine/health', (_req, res) => {
    res.json({ status: 'ok', port: config.port, uptime: process.uptime() });
});

// HTTP server
const server = http.createServer(app);

// WebSocket server
const editorWSS = new WebSocketServer({ noServer: true, perMessageDeflate: false });
setupEditorWebSocket(editorWSS);

server.on('upgrade', (req, socket, head) => {
    const pathname = req.url?.split('?')[0];

    if (pathname === '/ws/engine') {
        editorWSS.handleUpgrade(req, socket, head, (ws) => {
            editorWSS.emit('connection', ws, req);
        });
    } else {
        socket.destroy();
    }
});

// Start
server.listen(config.port, async () => {
    console.log(`[Server] Running on port ${config.port} (${config.nodeEnv})`);

    // Validate all game templates at startup
    import('./ws/services/pipeline/template_loader.js').then(({ loadTemplateCatalog, loadTemplate }) => {
        import('./ws/services/pipeline/level_assembler.js').then(({ assembleGame }) => {
            const catalog = loadTemplateCatalog();
            let passed = 0, failed = 0;
            for (const t of catalog) {
                const template = loadTemplate(t.id);
                if (!template?._folderPath) { failed++; continue; }
                try {
                    assembleGame(template._folderPath);
                    passed++;
                } catch (e: any) {
                    console.error(`[Templates] FAILED: ${t.id} — ${e.message}`);
                    failed++;
                }
            }
            console.log(`[Templates] ${passed}/${catalog.length} templates validated${failed > 0 ? `, ${failed} failed` : ''}`);
        });
    });

    // Asset generators (non-blocking, run in background)
    import('./generators/thumbnail_generator.js').then(({ generateThumbnails }) => {
        generateThumbnails(config.assetsDir).catch(e => console.error('[Thumbnails] Failed:', e));
    });
    import('./generators/collision_mesh_generator.js').then(({ generateCollisionMeshes }) => {
        generateCollisionMeshes(config.assetsDir).catch(e => console.error('[CollisionMesh] Failed:', e));
    });
    import('./generators/lod_generator.js').then(({ generateLODs }) => {
        generateLODs(config.assetsDir).catch(e => console.error('[LOD] Failed:', e));
    });
});
