import { WebSocketServer, WebSocket } from 'ws';
import { URL } from 'url';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { verifyToken, type AuthUser } from '../middleware/auth.js';
import db from '../db/connection.js';
import { callLLMStream, type LLMMessage } from './services/llm.js';

interface EditorClient {
    ws: WebSocket;
    clientId: string;
    projectId: string;
    userId: number;
    username: string;
    chatSessionId: string;
    abortController: AbortController | null;
}

const clients = new Map<string, EditorClient>();

const stmtGetProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const stmtUpdateData = db.prepare("UPDATE projects SET project_data = ?, updated_at = datetime('now') WHERE id = ?");
const stmtInsertMessage = db.prepare("INSERT INTO chat_messages (project_id, chat_session_id, role, content) VALUES (?, ?, ?, ?)");
const stmtGetHistory = db.prepare("SELECT id, role, content, created_at FROM chat_messages WHERE project_id = ? AND chat_session_id = ? ORDER BY id ASC");

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
        const chatSessionId = `s_${randomUUID().slice(0, 8)}`;
        const client: EditorClient = {
            ws,
            clientId,
            projectId,
            userId: user.id,
            username: user.username,
            chatSessionId,
            abortController: null,
        };

        clients.set(clientId, client);

        // Send connected confirmation
        send(client, 'connected', {
            projectId,
            userId: user.id,
            username: user.username,
            clientId,
            chatSessionId,
            isOwner: true,
            permission: 'owner',
        });

        // Send chat history
        const history = stmtGetHistory.all(projectId, chatSessionId) as any[];
        if (history.length > 0) {
            send(client, 'chat_history', {
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content })),
            });
        }

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
        case 'chat_message':
            handleChatMessage(client, data);
            break;

        case 'new_chat_session': {
            const newSessionId = `s_${randomUUID().slice(0, 8)}`;
            client.chatSessionId = newSessionId;
            send(client, 'chat_cleared', {});
            send(client, 'connected', { chatSessionId: newSessionId });
            break;
        }

        case 'list_chat_sessions': {
            const sessions = db.prepare(
                "SELECT DISTINCT chat_session_id, MIN(created_at) as created_at, MIN(content) as preview FROM chat_messages WHERE project_id = ? AND role = 'user' GROUP BY chat_session_id ORDER BY created_at DESC"
            ).all(client.projectId) as any[];
            send(client, 'chat_sessions', {
                sessions: sessions.map(s => ({
                    id: s.chat_session_id,
                    preview: (s.preview ?? '').slice(0, 80),
                    createdAt: s.created_at,
                    active: s.chat_session_id === client.chatSessionId,
                })),
            });
            break;
        }

        case 'switch_chat_session': {
            const sessionId = data?.sessionId;
            if (!sessionId) break;
            client.chatSessionId = sessionId;
            const history = stmtGetHistory.all(client.projectId, sessionId) as any[];
            send(client, 'chat_history', {
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content })),
            });
            send(client, 'connected', { chatSessionId: sessionId });
            break;
        }

        case 'stop_generation':
            if (client.abortController) {
                client.abortController.abort();
                client.abortController = null;
            }
            send(client, 'chat_generation_stopped', {});
            break;

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

function handleChatMessage(client: EditorClient, data: any): void {
    const content = data?.content;
    if (!content || typeof content !== 'string') return;

    // Save user message
    stmtInsertMessage.run(client.projectId, client.chatSessionId, 'user', content);

    // Build conversation history for LLM
    const history = stmtGetHistory.all(client.projectId, client.chatSessionId) as any[];
    const messages: LLMMessage[] = [
        { role: 'system', content: 'Your name is ParallaxPro AI. You are the built-in assistant for the ParallaxPro 3D game engine editor. When asked who you are, always say you are ParallaxPro AI. Help the user build games. Be concise and helpful.' },
        ...history.map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
    ];

    // Stream response
    send(client, 'chat_response_start', {});

    const abortController = new AbortController();
    client.abortController = abortController;

    callLLMStream(messages, {
        onChunk: (text) => {
            send(client, 'chat_response_chunk', { content: text });
        },
        onDone: (fullText) => {
            client.abortController = null;
            const result = stmtInsertMessage.run(client.projectId, client.chatSessionId, 'assistant', fullText);

            send(client, 'chat_response_end', {
                fullContent: fullText,
                messageId: Number(result.lastInsertRowid),
            });
            send(client, 'dialogue_done', {});
        },
        onError: (error) => {
            client.abortController = null;
            send(client, 'chat_response_end', {
                fullContent: `*Error: ${error}*`,
            });
            send(client, 'dialogue_done', {});
        },
    }, abortController.signal);
}
