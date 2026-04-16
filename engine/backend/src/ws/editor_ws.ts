import { WebSocketServer, WebSocket } from 'ws';
import { URL, fileURLToPath } from 'url';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { config } from '../config.js';
import { verifyToken, type AuthUser } from '../middleware/auth.js';
import { consumeWsTicket } from './ws_tickets.js';
import type { EnginePlugin } from '../plugin.js';
import db from '../db/connection.js';
import { callLLMStream, isDirectApiConfigured, type LLMMessage } from './services/llm.js';
import { SYSTEM_PROMPT, getProjectSummary } from './services/chat_protocol.js';
import { appendToLog } from './services/chat_log.js';
import { searchAssets } from '../routes/assets.js';
import { compile, execute, formatErrors, type ExecutionContext } from './llm_compiler/index.js';
import { getAvailableAgents, isAgentAvailable } from './services/pipeline/cli_availability.js';
import { runFixer } from './services/pipeline/cli_fixer.js';
import {
    parseProjectData,
    serializeProjectData,
    isLegacyProjectData,
    setFile,
    type ProjectData,
    type ProjectFiles,
} from './services/pipeline/project_files.js';
import { buildProject, type BuildResult } from './services/pipeline/project_builder.js';
import { applyIncomingFile } from './services/pipeline/project_save.js';

let _plugins: EnginePlugin[] = [];
export function setPlugins(plugins: EnginePlugin[]): void { _plugins = plugins; }

interface EditorClient {
    ws: WebSocket;
    clientId: string;
    projectId: string;
    userId: number;
    username: string;
    authToken: string;
    chatSessionId: string;
    activeSceneKey: string;
    abortController: AbortController | null;
    /** User prefs forwarded from the frontend's localStorage on each chat
     *  message. Remembered so retries in the same turn re-use the same
     *  routing (chat LLM provider and fixer CLI). */
    chatAgent?: string;
    editingAgent?: string;
}

const clients = new Map<string, EditorClient>();

// Per-user LLM rate limiting: max 10 requests per minute
const llmRateLimit = new Map<number, { count: number; resetAt: number }>();
const LLM_RATE_LIMIT = 10;
const LLM_RATE_WINDOW = 60000;

function checkLLMRateLimit(userId: number): boolean {
    const now = Date.now();
    const entry = llmRateLimit.get(userId);
    if (!entry || now > entry.resetAt) {
        llmRateLimit.set(userId, { count: 1, resetAt: now + LLM_RATE_WINDOW });
        return true;
    }
    if (entry.count >= LLM_RATE_LIMIT) return false;
    entry.count++;
    return true;
}

const stmtGetProject = db.prepare('SELECT * FROM projects WHERE id = ?');
const stmtUpdateData = db.prepare("UPDATE projects SET project_data = ?, updated_at = datetime('now') WHERE id = ?");
const stmtInsertMessage = db.prepare("INSERT INTO chat_messages (project_id, chat_session_id, role, content, file_changes, project_data_snapshot, project_data_before) VALUES (?, ?, ?, ?, ?, ?, ?)");
const stmtGetHistory = db.prepare("SELECT id, role, content, feedback, file_changes, created_at FROM chat_messages WHERE project_id = ? AND chat_session_id = ? ORDER BY id ASC");
const stmtSetFeedback = db.prepare("UPDATE chat_messages SET feedback = ? WHERE id = ? AND project_id = ?");
const stmtGetMessage = db.prepare("SELECT * FROM chat_messages WHERE id = ? AND project_id = ?");
const stmtDeleteAfter = db.prepare("DELETE FROM chat_messages WHERE project_id = ? AND chat_session_id = ? AND id > ?");
const stmtDeleteFrom = db.prepare("DELETE FROM chat_messages WHERE project_id = ? AND chat_session_id = ? AND id >= ?");

function send(client: EditorClient, type: string, data: any): void {
    if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(JSON.stringify({ type, data }));
    }
}

/**
 * Push a name change to every editor client currently watching this project.
 * Called from the async project-name generator in routes/projects.ts — the
 * heartbeat is a raw WS ping, so renames don't propagate on their own.
 */
export function broadcastProjectRenamed(projectId: string, name: string): void {
    for (const client of clients.values()) {
        if (client.projectId === projectId) {
            send(client, 'project_renamed', { projectId, name });
        }
    }
}

export function setupEditorWebSocket(wss: WebSocketServer): void {
    wss.on('connection', (ws, req) => {
        const url = new URL(req.url ?? '', 'http://localhost');
        const projectId = url.searchParams.get('project');
        const ticket = url.searchParams.get('ticket') ?? '';
        const token = url.searchParams.get('token') ?? ''; // Legacy fallback

        if (!projectId) {
            ws.close(4000, 'Missing project ID');
            return;
        }

        // Auth — try ticket first (preferred), then legacy token
        let user: AuthUser | null = null;
        let authToken = '';

        if (ticket) {
            const ticketData = consumeWsTicket(ticket);
            if (ticketData) {
                user = ticketData.user;
                authToken = ticketData.authToken;
            }
        }

        if (!user && token) {
            const pluginVerify = _plugins.find(p => p.verifyWsToken);
            if (pluginVerify?.verifyWsToken) {
                user = pluginVerify.verifyWsToken(token);
            } else {
                user = verifyToken(token);
            }
            authToken = token;
        }

        if (!user && config.isDev && !ticket && !token) {
            user = { id: 1, email: 'dev@local', username: 'dev' };
        }

        if (!user) {
            ws.close(4001, 'Invalid token');
            return;
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
        const pd = parseProjectData(row.project_data);
        if (isLegacyProjectData(pd)) {
            ws.close(4005, 'Legacy project — please recreate it after the file-tree migration.');
            return;
        }
        const built = buildProject(projectId, pd.files);
        const firstSceneKey = built.activeSceneKey;
        const client: EditorClient = {
            ws,
            clientId,
            projectId,
            userId: user.id,
            username: user.username,
            authToken,
            chatSessionId,
            activeSceneKey: firstSceneKey,
            abortController: null,
        };

        clients.set(clientId, client);

        // Plugin connection hooks
        for (const p of _plugins) {
            if (p.onWsConnection) p.onWsConnection(client);
        }

        // Send connected confirmation
        send(client, 'connected', {
            projectId,
            userId: user.id,
            username: user.username,
            clientId,
            chatSessionId,
            isOwner: true,
            permission: 'owner',
            availableAgents: getAvailableAgents().map(a => ({
                id: a.id,
                label: a.label,
                caption: a.caption,
            })),
            llmApiAvailable: isDirectApiConfigured(),
        });

        // Send chat history
        const history = stmtGetHistory.all(projectId, chatSessionId) as any[];
        if (history.length > 0) {
            send(client, 'chat_history', {
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [] })),
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
                // Plugin message hooks — return true to prevent default handling
                let handled = false;
                for (const p of _plugins) {
                    if (p.onWsMessage && p.onWsMessage(client, msg.type, msg.data)) {
                        handled = true;
                        break;
                    }
                }
                if (!handled) handleMessage(client, msg);
            } catch (e) {
                console.error('[WS] Failed to parse message:', e);
            }
        });

        ws.on('close', () => {
            clearInterval(pingInterval);
            clients.delete(clientId);
            // Kill any in-flight CLI run. Without this, a user who closes
            // their tab (or whose network drops, or whose browser crashes)
            // leaves the spawned CLI agent billing tokens against a
            // websocket that's gone. That's how multi-day zombie agents
            // happen — see the 1.8-day opencode we cleaned up in ops.
            if (client.abortController) {
                client.abortController.abort();
                client.abortController = null;
            }
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
            if (!checkLLMRateLimit(client.userId)) {
                send(client, 'chat_response_end', { fullContent: 'You\'re sending messages too fast. Please wait a moment.' });
                send(client, 'dialogue_done', {});
                break;
            }
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
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [] })),
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

        case 'message_feedback': {
            const feedback = data?.feedback;
            const messageId = data?.messageId;
            if (messageId && (feedback === 'up' || feedback === 'down' || feedback === 'none')) {
                stmtSetFeedback.run(feedback === 'none' ? null : feedback, messageId, client.projectId);
            }
            break;
        }

        case 'revert_to_message': {
            const msg = stmtGetMessage.get(data?.messageId, client.projectId) as any;
            if (!msg?.project_data_snapshot) {
                send(client, 'error', { message: 'No snapshot available for this message.' });
                break;
            }
            stmtUpdateData.run(msg.project_data_snapshot, client.projectId);
            stmtDeleteAfter.run(client.projectId, client.chatSessionId, msg.id);
            const restored = parseProjectData(msg.project_data_snapshot);
            if (!isLegacyProjectData(restored)) rebuildAndPush(client, restored, { sceneKey: client.activeSceneKey });
            const history = stmtGetHistory.all(client.projectId, client.chatSessionId) as any[];
            send(client, 'chat_history', {
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [] })),
            });
            break;
        }

        case 'revert_to_before_message': {
            const msg = stmtGetMessage.get(data?.messageId, client.projectId) as any;
            if (!msg) break;
            let beforeData = msg.project_data_before;
            if (!beforeData) {
                const prevUser = db.prepare(
                    "SELECT project_data_before FROM chat_messages WHERE project_id = ? AND chat_session_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1"
                ).get(client.projectId, client.chatSessionId, msg.id) as any;
                beforeData = prevUser?.project_data_before;
            }
            if (!beforeData) {
                send(client, 'error', { message: 'No snapshot available for before this message.' });
                break;
            }
            stmtUpdateData.run(beforeData, client.projectId);
            stmtDeleteFrom.run(client.projectId, client.chatSessionId, msg.id);
            const restored = parseProjectData(beforeData);
            if (!isLegacyProjectData(restored)) rebuildAndPush(client, restored, { sceneKey: client.activeSceneKey });
            const history = stmtGetHistory.all(client.projectId, client.chatSessionId) as any[];
            send(client, 'chat_history', {
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [] })),
            });
            break;
        }

        case 'regenerate_response': {
            const msg = stmtGetMessage.get(data?.messageId, client.projectId) as any;
            if (!msg || msg.role !== 'assistant') break;
            // Find the user message before this assistant message
            const prevUser = db.prepare(
                "SELECT * FROM chat_messages WHERE project_id = ? AND chat_session_id = ? AND id < ? AND role = 'user' ORDER BY id DESC LIMIT 1"
            ).get(client.projectId, client.chatSessionId, msg.id) as any;
            if (!prevUser) break;
            // Restore project state to before the assistant response
            if (msg.project_data_before || prevUser.project_data_before) {
                const beforeData = prevUser.project_data_before || msg.project_data_before;
                stmtUpdateData.run(beforeData, client.projectId);
            }
            // Delete the assistant message and everything after
            stmtDeleteFrom.run(client.projectId, client.chatSessionId, msg.id);
            // Send updated chat history so frontend removes deleted messages
            const history = stmtGetHistory.all(client.projectId, client.chatSessionId) as any[];
            send(client, 'chat_history', {
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [] })),
            });
            // Reload scene to restored state
            const restoredPd = readProjectData(client.projectId);
            if (restoredPd && !isLegacyProjectData(restoredPd)) {
                rebuildAndPush(client, restoredPd, { sceneKey: client.activeSceneKey });
            }
            // Re-trigger: agent override routes to CLI fixer, otherwise LLM.
            send(client, 'chat_response_start', {});
            const abortController = new AbortController();
            client.abortController = abortController;
            const agent = typeof data?.agent === 'string' ? data.agent : '';
            if ((agent === 'claude' || agent === 'codex' || agent === 'opencode' || agent === 'copilot') && isAgentAvailable(agent)) {
                runDirectFixer(client, prevUser.content, agent, abortController);
            } else {
                runLLMWithRetry(client, abortController, 0, [], []);
            }
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

    const pd = readProjectData(client.projectId);
    if (!pd || isLegacyProjectData(pd)) return;

    const result = applyIncomingFile(pd, client.projectId, filePath, content);
    if (result.error) {
        send(client, 'file_save_error', { path: filePath, error: result.error });
        return;
    }
    stmtUpdateData.run(serializeProjectData(pd), client.projectId);
    if (result.shouldRebuildAndPush) {
        rebuildAndPush(client, pd, { sceneKey: client.activeSceneKey });
    }
    send(client, 'file_saved', { path: filePath });
}

function handleProjectSave(client: EditorClient, data: any): void {
    const files = data?.files;
    if (!files || typeof files !== 'object') return;

    const pd = readProjectData(client.projectId);
    if (!pd || isLegacyProjectData(pd)) return;

    let shouldRebuildAndPush = false;
    for (const [filePath, content] of Object.entries(files)) {
        const result = applyIncomingFile(pd, client.projectId, filePath, content);
        if (result.shouldRebuildAndPush) shouldRebuildAndPush = true;
    }

    stmtUpdateData.run(serializeProjectData(pd), client.projectId);
    if (shouldRebuildAndPush) {
        rebuildAndPush(client, pd, { sceneKey: client.activeSceneKey });
    }
    send(client, 'project_saved', { success: true });
}

/** Read parsed project data from DB. Returns null if project missing. */
function readProjectData(projectId: string): ProjectData | null {
    const row = stmtGetProject.get(projectId) as any;
    if (!row) return null;
    return parseProjectData(row.project_data);
}

/** Compact snapshot for chat history — file tree only (no assembled output). */
function getProjectSnapshot(projectId: string): string {
    const pd = readProjectData(projectId);
    if (!pd) return JSON.stringify({ projectConfig: { name: '' }, files: {} });
    return serializeProjectData(pd);
}

/** Rebuild the project and broadcast the assembled scene/scripts/uiFiles. */
function rebuildAndPush(client: EditorClient, pd: ProjectData, opts: { sceneKey: string }): BuildResult {
    const built = buildProject(client.projectId, pd.files, { activeSceneKey: opts.sceneKey });
    if (!built.success) {
        send(client, 'build_error', { error: built.error });
        return built;
    }
    const sceneData = built.scenes[opts.sceneKey] || built.scenes[built.activeSceneKey];
    send(client, 'project_reload', {
        sceneKey: built.activeSceneKey,
        sceneData,
        scripts: built.scripts,
        uiFiles: built.uiFiles,
        sourceMap: built.sourceMap,
    });
    return built;
}

const MAX_RETRIES = 3;

function handleChatMessage(client: EditorClient, data: any): void {
    const content = data?.content;
    if (!content || typeof content !== 'string') return;

    // Cache the frontend's localStorage prefs for this turn. Retries within
    // the same turn (runLLMWithRetry, FIX_GAME escalation) re-read these.
    if (typeof data?.chatAgent === 'string') client.chatAgent = data.chatAgent;
    if (typeof data?.editingAgent === 'string') client.editingAgent = data.editingAgent;

    // Plugin chat hooks
    for (const p of _plugins) {
        if (p.onChatMessage) p.onChatMessage(client, content);
    }

    // Save user message with current project state as "before" snapshot
    const beforeSnapshot = getProjectSnapshot(client.projectId);
    stmtInsertMessage.run(client.projectId, client.chatSessionId, 'user', content, null, null, beforeSnapshot);
    send(client, 'chat_response_start', {});

    const abortController = new AbortController();
    client.abortController = abortController;

    // Agent override: when the user explicitly picks a CLI agent in the UI
    // we skip the small LLM entirely and hand the raw message to the CLI
    // fixer. This is the "direct" path — best for concrete fix/feature asks.
    const agent = typeof data?.agent === 'string' ? data.agent : '';
    if (agent === 'claude' || agent === 'codex' || agent === 'opencode' || agent === 'copilot') {
        if (!isAgentAvailable(agent)) {
            finishChat(client, `*Agent "${agent}" is not installed on this server.*`);
            return;
        }
        runDirectFixer(client, content, agent, abortController);
        return;
    }

    runLLMWithRetry(client, abortController, 0, [], []);
}

/**
 * Bypass the LLM and hand the user's message straight to the CLI fixer.
 * Fired when the editor picks a specific CLI agent (claude / codex) for the
 * message. Mirrors the FIX_GAME executor path — runs the fixer, commits any
 * produced file changes, and closes out the chat turn with a summary.
 */
async function runDirectFixer(client: EditorClient, description: string, cliOverride: string, abortController: AbortController): Promise<void> {
    const sendStatus = (msg: string) => send(client, 'fix_progress', { text: msg });
    try {
        const pd = readProjectData(client.projectId);
        if (!pd || isLegacyProjectData(pd)) {
            finishChat(client, '*Project files unavailable — cannot run fixer.*');
            return;
        }

        const fixResult = await runFixer(
            client.projectId,
            description,
            pd.files,
            client.activeSceneKey,
            sendStatus,
            abortController.signal,
            cliOverride,
        );

        if (fixResult.costUsd) {
            for (const p of _plugins) {
                if (p.onFixerCost) p.onFixerCost(client, fixResult.costUsd);
            }
        }

        // If Stop fired while the CLI was running, don't commit the partial
        // files to the project DB. The 20k-tokens/min estimate above still
        // lands in the usage dashboard.
        if (abortController.signal.aborted) {
            finishChat(client, '*Generation stopped.*');
            return;
        }

        const fileChanges: { path: string; type: string }[] = [];
        if (fixResult.success && fixResult.filesChanged.length > 0) {
            const updates: Record<string, string | null> = {};
            for (const [k, v] of Object.entries(fixResult.changedFiles)) updates[k] = v;
            for (const k of fixResult.deletedFiles) updates[k] = null;
            const pd2 = readProjectData(client.projectId);
            if (pd2) {
                for (const [filePath, cont] of Object.entries(updates)) {
                    if (cont === null) delete pd2.files[filePath];
                    else setFile(pd2, filePath, cont);
                }
                stmtUpdateData.run(serializeProjectData(pd2), client.projectId);
                rebuildAndPush(client, pd2, { sceneKey: client.activeSceneKey });
            }
            for (const f of fixResult.filesChanged) {
                const isDeleted = fixResult.deletedFiles.includes(f);
                fileChanges.push({ path: f, type: isDeleted ? 'deleted' : 'modified' });
            }
        }

        const agentLabel = cliOverride === 'codex' ? 'Codex'
            : cliOverride === 'opencode' ? 'OpenCode'
            : cliOverride === 'copilot' ? 'GitHub Copilot'
            : 'Claude Code';
        const summary = fixResult.success
            ? (fixResult.summary || `${agentLabel} applied the fix.`)
            : `*${agentLabel} failed: ${fixResult.summary}*`;
        finishChat(client, summary, fileChanges);
    } catch (e: any) {
        client.abortController = null;
        if (abortController.signal.aborted) {
            finishChat(client, '*Generation stopped.*');
        } else {
            console.error('[DirectFixer] Error:', e?.message || e);
            finishChat(client, `*Error: ${e?.message || 'Unknown error'}*`);
        }
    }
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

/**
 * Returns the AI-facing view of a project: assembled scenes/scripts/uiFiles
 * (so the AI sees the same world the user sees) plus the underlying file tree
 * for tools that mutate the source (LOAD_TEMPLATE, FIX_GAME, CREATE_GAME, EDIT).
 */
function getProjectData(projectId: string): any {
    const pd = readProjectData(projectId);
    if (!pd || isLegacyProjectData(pd)) return {};
    const built = buildProject(projectId, pd.files);
    return {
        projectConfig: pd.projectConfig,
        files: pd.files,
        scenes: built.scenes,
        scripts: built.scripts,
        uiFiles: built.uiFiles,
        sourceMap: built.sourceMap,
        multiplayerConfig: built.multiplayerConfig,
        activeSceneKey: built.activeSceneKey,
    };
}

function buildExecContext(client: EditorClient, abortSignal?: AbortSignal): ExecutionContext {
    return {
        sendToFrontend: (type, data) => send(client, type, data),
        getProjectData: () => getProjectData(client.projectId),
        commitFiles: (updates: Record<string, string | null>) => {
            const pd = readProjectData(client.projectId);
            if (!pd) return null;
            for (const [filePath, content] of Object.entries(updates)) {
                if (content === null) delete pd.files[filePath];
                else setFile(pd, filePath, content);
            }
            stmtUpdateData.run(serializeProjectData(pd), client.projectId);
            return rebuildAndPush(client, pd, { sceneKey: client.activeSceneKey });
        },
        replaceFiles: (newFiles: ProjectFiles, opts?: { name?: string }) => {
            const pd = readProjectData(client.projectId) || { projectConfig: { name: 'Untitled' }, files: {} };
            pd.files = { ...newFiles };
            if (opts?.name) pd.projectConfig.name = opts.name;
            stmtUpdateData.run(serializeProjectData(pd), client.projectId);
            return rebuildAndPush(client, pd, { sceneKey: client.activeSceneKey });
        },
        reloadScene: (sceneKey, sceneData) => {
            send(client, 'scene_reload', { sceneKey, sceneData });
        },
        searchAssets,
        abortSignal,
        onFixerCost: (costUsd: number) => {
            for (const p of _plugins) {
                if (p.onFixerCost) p.onFixerCost(client, costUsd);
            }
        },
        projectId: client.projectId,
        activeSceneKey: client.activeSceneKey,
        editingAgent: client.editingAgent,
    };
}

function finishChat(client: EditorClient, displayContent: string, fileChanges: any[] = []): void {
    // Single terminal cleanup point for the in-flight abort handle. Nulling
    // anywhere else (mid-chain, between LLM stream end and tool execute,
    // etc.) breaks Stop mid-flow because the Stop handler short-circuits on
    // a null client.abortController.
    client.abortController = null;
    // Save assistant message with post-edit snapshot
    const snapshot = getProjectSnapshot(client.projectId);
    const fileChangesJson = fileChanges.length > 0 ? JSON.stringify(fileChanges) : null;
    const dbResult = stmtInsertMessage.run(
        client.projectId, client.chatSessionId, 'assistant', displayContent,
        fileChangesJson, snapshot, null
    );
    send(client, 'chat_response_end', {
        fullContent: displayContent,
        messageId: Number(dbResult.lastInsertRowid),
        fileChanges,
    });
    send(client, 'dialogue_done', {});
}

async function runLLMWithRetry(
    client: EditorClient,
    abortController: AbortController,
    attempt: number,
    retryContext: LLMMessage[],
    accumulatedFileChanges: any[],
): Promise<void> {
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

    // Check budget before LLM call
    for (const p of _plugins) {
        if (p.checkLLMBudget) {
            const budget = await p.checkLLMBudget(client);
            if (!budget.allowed) {
                finishChat(client, budget.error || 'Token usage limit reached. Please upgrade your plan.');
                return;
            }
        }
    }

    callLLMStream(messages, {
        onChunk: () => {},
        onDone: async (fullText, usage) => {
            // If the user pressed Stop while the LLM was streaming, bail
            // now — don't compile, don't execute tools, don't recurse into
            // the next turn. Token usage from the stream is still reported
            // below so the user's dashboard reflects what was consumed.
            if (abortController.signal.aborted) {
                if (usage) {
                    for (const p of _plugins) {
                        if (p.onLLMUsage) p.onLLMUsage(client, usage);
                    }
                }
                finishChat(client, '*Generation stopped.*');
                return;
            }

            // Report token usage to plugins
            if (usage) {
                for (const p of _plugins) {
                    if (p.onLLMUsage) p.onLLMUsage(client, usage);
                }
            }

            // Log exact LLM response
            appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: fullText });

            const compiled = compile(fullText, getProjectData(client.projectId));

            if (!compiled.success && attempt < MAX_RETRIES) {
                const errorMsg = formatErrors(compiled.errors);
                runLLMWithRetry(client, abortController, attempt + 1, [
                    ...retryContext,
                    { role: 'assistant', content: fullText },
                    { role: 'user', content: `[SYSTEM] Compile errors. Fix and try again:\n${errorMsg}` },
                ], accumulatedFileChanges);
                return;
            }

            if (!compiled.success) {
                finishChat(client, 'Sorry, I was unable to complete that request. Please try rephrasing.');
                return;
            }

            const execResult = await execute(compiled.ast, buildExecContext(client, abortController.signal));

            // Stop may have fired during tool execution (e.g. mid-CREATE_GAME
            // CLI spawn). The CLI itself gets killed via abortSignal, but we
            // still need to prevent the follow-up LLM turn and not announce
            // success for the aborted tool call.
            if (abortController.signal.aborted) {
                finishChat(client, '*Generation stopped.*');
                return;
            }

            const allFileChanges = [...accumulatedFileChanges, ...execResult.fileChanges];

            // Tool call results — feed back to AI for a follow-up response
            if (execResult.toolResults && attempt < MAX_RETRIES) {
                runLLMWithRetry(client, abortController, attempt + 1, [
                    ...retryContext,
                    { role: 'assistant', content: fullText },
                    { role: 'user', content: `[SYSTEM] Tool results:\n${execResult.toolResults}${
                        compiled.ast.some(n => n.kind === 'edit')
                            ? '\n\nIMPORTANT: Your <<<EDIT>>> block was NOT executed because you included a tool call in the same response.'
                            : ''
                    }\n\nNow continue with the user's request based on the results above.` },
                ], allFileChanges);
                return;
            }

            if (execResult.errors.length > 0 && attempt < MAX_RETRIES) {
                runLLMWithRetry(client, abortController, attempt + 1, [
                    ...retryContext,
                    { role: 'assistant', content: fullText },
                    { role: 'user', content: `[SYSTEM] Runtime errors. Fix and try again:\n${execResult.errors.join('\n')}` },
                ], allFileChanges);
                return;
            }

            if (execResult.errors.length > 0) {
                finishChat(client, 'Sorry, I was unable to complete that request. Please try rephrasing.');
                return;
            }

            const displayContent = execResult.userMessages.join('\n') || '*Done.*';
            finishChat(client, displayContent, allFileChanges);
        },
        onError: (error) => {
            client.abortController = null;
            finishChat(client, `*Error: ${error}*`);
        },
    }, abortController.signal, client.chatAgent);
}
