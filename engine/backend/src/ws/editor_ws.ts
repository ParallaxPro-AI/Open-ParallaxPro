import { WebSocketServer, WebSocket } from 'ws';
import { URL, fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { verifyToken, type AuthUser } from '../middleware/auth.js';
import db from '../db/connection.js';
import { callLLMStream, type LLMMessage } from './services/llm.js';
import { SYSTEM_PROMPT, getProjectSummary } from './services/chat_protocol.js';
import { appendToLog } from './services/chat_log.js';
import { searchAssets } from '../routes/assets.js';
import { compile, execute, formatErrors, type ExecutionContext } from './llm_compiler/index.js';

interface EditorClient {
    ws: WebSocket;
    clientId: string;
    projectId: string;
    userId: number;
    username: string;
    chatSessionId: string;
    activeSceneKey: string;
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
        const chatSessionId = `u${user.id}_p${projectId.slice(0, 8)}_${randomUUID()}`;
        const pd = row.project_data ? JSON.parse(row.project_data) : {};
        const firstSceneKey = Object.keys(pd.scenes || {})[0] || 'main.json';
        const client: EditorClient = {
            ws,
            clientId,
            projectId,
            userId: user.id,
            username: user.username,
            chatSessionId,
            activeSceneKey: firstSceneKey,
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

        case 'set_active_scene':
            if (data?.sceneKey && typeof data.sceneKey === 'string') {
                client.activeSceneKey = data.sceneKey;
            }
            break;

        case 'new_chat_session': {
            const newSessionId = `u${client.userId}_p${client.projectId.slice(0, 8)}_${randomUUID()}`;
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

        case 'get_raw_session_files': {
            const logPath = path.join(
                path.dirname(fileURLToPath(import.meta.url)),
                '../../chat_logs',
                `${client.projectId}_${client.chatSessionId}.jsonl`
            );
            const files: { name: string; content: string }[] = [];
            try {
                if (fs.existsSync(logPath)) {
                    const lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(Boolean);
                    let idx = 0;
                    for (const line of lines) {
                        const entry = JSON.parse(line);
                        const label = entry.role === 'user' ? 'Human' : entry.role === 'assistant' ? 'AI' : 'System';
                        files.push({ name: `${String(idx).padStart(3, '0')}_${label}`, content: entry.content });
                        idx++;
                    }
                }
            } catch {}
            send(client, 'raw_session_files', { sessionId: client.chatSessionId, files });
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

const MAX_RETRIES = 3;

function handleChatMessage(client: EditorClient, data: any): void {
    const content = data?.content;
    if (!content || typeof content !== 'string') return;

    stmtInsertMessage.run(client.projectId, client.chatSessionId, 'user', content);
    send(client, 'chat_response_start', {});

    const abortController = new AbortController();
    client.abortController = abortController;

    runLLMWithRetry(client, abortController, 0, []);
}

function buildMessages(client: EditorClient, retryContext: LLMMessage[]): LLMMessage[] {
    const history = stmtGetHistory.all(client.projectId, client.chatSessionId) as any[];

    // Always include fresh project state so AI knows current scene
    const pd = getProjectData(client.projectId);
    const summary = getProjectSummary(pd, client.activeSceneKey);

    return [
        { role: 'system', content: SYSTEM_PROMPT + summary },
        ...history.map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
        ...retryContext,
    ];
}

function getProjectData(projectId: string): any {
    const r = stmtGetProject.get(projectId) as any;
    return r?.project_data ? JSON.parse(r.project_data) : {};
}

function buildExecContext(client: EditorClient): ExecutionContext {
    return {
        sendToFrontend: (type, data) => send(client, type, data),
        getProjectData: () => getProjectData(client.projectId),
        saveProjectData: (data) => {
            stmtUpdateData.run(JSON.stringify(data), client.projectId);
        },
        reloadScene: (sceneKey, sceneData) => {
            send(client, 'scene_reload', { sceneKey, sceneData });
        },
        searchAssets,
        projectId: client.projectId,
        activeSceneKey: client.activeSceneKey,
    };
}

function finishChat(client: EditorClient, displayContent: string, fileChanges: any[] = []): void {
    const dbResult = stmtInsertMessage.run(client.projectId, client.chatSessionId, 'assistant', displayContent);
    send(client, 'chat_response_end', {
        fullContent: displayContent,
        messageId: Number(dbResult.lastInsertRowid),
        fileChanges,
    });
    send(client, 'dialogue_done', {});
}

function runLLMWithRetry(
    client: EditorClient,
    abortController: AbortController,
    attempt: number,
    retryContext: LLMMessage[],
): void {
    const messages = buildMessages(client, retryContext);

    // Log: on first attempt just the user message (system prompt is always the same).
    // On retry, log the retry context. LLM response is always logged in onDone.
    if (attempt === 0) {
        const userMsg = messages.filter(m => m.role === 'user').pop();
        if (userMsg) appendToLog(client.projectId, client.chatSessionId, { role: 'user', content: userMsg.content });
    } else {
        // Only log the system/user retry message, not the assistant response (already logged in onDone)
        const lastRetryMsg = retryContext[retryContext.length - 1];
        if (lastRetryMsg && lastRetryMsg.role === 'user') {
            appendToLog(client.projectId, client.chatSessionId, { role: 'user', content: lastRetryMsg.content });
        }
    }

    callLLMStream(messages, {
        onChunk: () => {},
        onDone: (fullText) => {
            client.abortController = null;
            // Log exact LLM response
            appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: fullText });

            const compiled = compile(fullText, getProjectData(client.projectId));

            if (!compiled.success && attempt < MAX_RETRIES) {
                const errorMsg = formatErrors(compiled.errors);
                runLLMWithRetry(client, abortController, attempt + 1, [
                    ...retryContext,
                    { role: 'assistant', content: fullText },
                    { role: 'user', content: `[SYSTEM] Compile errors. Fix and try again:\n${errorMsg}` },
                ]);
                return;
            }

            if (!compiled.success) {
                finishChat(client, 'Sorry, I was unable to complete that request. Please try rephrasing.');
                return;
            }

            const execResult = execute(compiled.ast, buildExecContext(client));

            // Tool call results — feed back to AI for a follow-up response
            if (execResult.toolResults && attempt < MAX_RETRIES) {
                runLLMWithRetry(client, abortController, attempt + 1, [
                    ...retryContext,
                    { role: 'assistant', content: fullText },
                    { role: 'user', content: `[SYSTEM] Tool results:\n${execResult.toolResults}${
                        compiled.ast.some(n => n.kind === 'edit')
                            ? '\n\nIMPORTANT: Your <<<EDIT>>> block was NOT executed because you included a tool call in the same response.'
                            : ''
                    }\n\nNow write your <<<EDIT>>> block using the results above. Do NOT call GET_EDIT_API or LIST_ASSETS again.` },
                ]);
                return;
            }

            if (execResult.errors.length > 0 && attempt < MAX_RETRIES) {
                runLLMWithRetry(client, abortController, attempt + 1, [
                    ...retryContext,
                    { role: 'assistant', content: fullText },
                    { role: 'user', content: `[SYSTEM] Runtime errors. Fix and try again:\n${execResult.errors.join('\n')}` },
                ]);
                return;
            }

            if (execResult.errors.length > 0) {
                finishChat(client, 'Sorry, I was unable to complete that request. Please try rephrasing.');
                return;
            }

            const displayContent = execResult.userMessages.join('\n') || '*Done.*';
            finishChat(client, displayContent, execResult.fileChanges);
        },
        onError: (error) => {
            client.abortController = null;
            finishChat(client, `*Error: ${error}*`);
        },
    }, abortController.signal);
}
