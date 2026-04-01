import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { config } from '../config.js';
import { verifyToken, type AuthUser } from '../middleware/auth.js';
import db from '../db/connection.js';

interface EditorClient {
    ws: WebSocket;
    clientId: string;
    projectId: string;
    userId: number;
    username: string;
}

const clients = new Map<string, EditorClient>();

const stmtGetProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const stmtUpdateData = db.prepare("UPDATE projects SET project_data = ?, updated_at = datetime('now') WHERE id = ?");

function send(client: EditorClient, type: string, data: any): void {
    if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type, data }));
    }
}

export function setupEditorWebSocket(wss: WebSocketServer): void {
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const projectId = url.searchParams.get('project');
        const token = url.searchParams.get('token') ?? '';

        if (!projectId) {
            ws.close(4000, 'Missing project ID');
            return;
        }

        // Auth
        let user: AuthUser;
        if (config.isDev && !token) {
            user = { id: 1, email: 'dev@local', username: 'dev' };
        } else {
            const verified = verifyToken(token);
            if (!verified) {
                ws.close(4001, 'Invalid token');
                return;
            }
            user = verified;
        }

        // Load project
        const row = stmtGetProject.get(projectId) as any;
        if (!row) {
            ws.close(4004, 'Project not found');
            return;
        }
        if (row.user_id !== user.id) {
            ws.close(4003, 'Access denied');
            return;
        }

        const clientId = `${user.id}_${Date.now()}`;
        const client: EditorClient = {
            ws,
            clientId,
            projectId,
            userId: user.id,
            username: user.username,
        };

        clients.set(clientId, client);

        // Send connected confirmation
        send(client, 'connected', {
            projectId,
            userId: user.id,
            username: user.username,
            clientId,
            isOwner: true,
            permission: 'owner',
        });

        // Heartbeat
        const pingInterval = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) ws.ping();
        }, 30000);

        // Message handler
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                handleMessage(client, msg);
            } catch (e) {
                console.error('[WS] Failed to parse message:', e);
            }
        });

        ws.on('close', () => {
            clearInterval(pingInterval);
            clients.delete(clientId);
        });

        ws.on('error', (err) => {
            console.error('[WS] Error:', err.message);
        });
    });
}

function handleMessage(client: EditorClient, msg: { type: string; data?: any }): void {
    const { type, data } = msg;

    switch (type) {
        case 'file_save':
            handleFileSave(client, data);
            break;

        case 'project_save':
            handleProjectSave(client, data);
            break;

        default:
            break;
    }
}

function handleFileSave(client: EditorClient, data: any): void {
    const { path: filePath, content } = data;
    if (!filePath || content === undefined) return;

    const row = stmtGetProject.get(client.projectId) as any;
    if (!row) return;

    const projectData = row.project_data ? JSON.parse(row.project_data) : {};

    if (filePath === 'projectConfig') {
        projectData.projectConfig = content;
    } else if (filePath.startsWith('scenes/')) {
        if (!projectData.scenes) projectData.scenes = {};
        projectData.scenes[filePath.replace('scenes/', '')] = content;
    } else if (filePath.startsWith('scripts/')) {
        if (!projectData.scripts) projectData.scripts = {};
        projectData.scripts[filePath.replace('scripts/', '')] = content;
    } else if (filePath.startsWith('uiFiles/')) {
        if (!projectData.uiFiles) projectData.uiFiles = {};
        projectData.uiFiles[filePath.replace('uiFiles/', '')] = content;
    }

    stmtUpdateData.run(JSON.stringify(projectData), client.projectId);
    send(client, 'file_saved', { path: filePath });
}

function handleProjectSave(client: EditorClient, data: any): void {
    const files = data?.files;
    if (!files || typeof files !== 'object') return;

    const row = stmtGetProject.get(client.projectId) as any;
    if (!row) return;

    const projectData = row.project_data ? JSON.parse(row.project_data) : {};

    for (const [filePath, content] of Object.entries(files)) {
        if (filePath === 'projectConfig') {
            projectData.projectConfig = content;
        } else if (filePath.startsWith('scenes/')) {
            if (!projectData.scenes) projectData.scenes = {};
            projectData.scenes[filePath.replace('scenes/', '')] = content;
        } else if (filePath.startsWith('scripts/')) {
            if (!projectData.scripts) projectData.scripts = {};
            projectData.scripts[filePath.replace('scripts/', '')] = content;
        } else if (filePath.startsWith('uiFiles/')) {
            if (!projectData.uiFiles) projectData.uiFiles = {};
            projectData.uiFiles[filePath.replace('uiFiles/', '')] = content;
        }
    }

    stmtUpdateData.run(JSON.stringify(projectData), client.projectId);
    send(client, 'project_saved', { success: true });
}
