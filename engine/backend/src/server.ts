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
const { setupEditorWebSocket } = await import('./ws/editor_ws.js');

// Express app
const app = express();
app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '10mb' }));

// Routes
app.use('/api/engine/projects', projectRoutes);

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
server.listen(config.port, () => {
    console.log(`[Server] Running on port ${config.port} (${config.nodeEnv})`);
});
