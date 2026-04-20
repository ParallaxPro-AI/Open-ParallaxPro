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
import { recordPendingFeedback, getPendingFeedback, resolveFeedback, getFeedbackById } from './services/feedback.js';
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
import {
    abortJob,
    isProjectLocked,
    readGenerationState,
    subscribeToJob,
    setGenerationJobsPlugins,
    startGenerationJob,
} from './services/pipeline/generation_jobs.js';

let _plugins: EnginePlugin[] = [];
export function setPlugins(plugins: EnginePlugin[]): void {
    _plugins = plugins;
    // generation_jobs also needs the plugin list so it can fire
    // onGenerationComplete hooks (used by the hosted email plugin).
    setGenerationJobsPlugins(plugins);
}

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
    /** Unsubscribe from the active CREATE_GAME job's progress stream.
     *  Nulled when no job is active for this project, or when the client
     *  disconnects. NOTE: this only unsubscribes from notifications — it
     *  deliberately does NOT abort the job, since generation outlives
     *  the WebSocket. Use stop_generation to actually kill the build. */
    jobUnsubscribe: (() => void) | null;
    /** User prefs forwarded from the frontend's localStorage on each chat
     *  message. Remembered so retries in the same turn re-use the same
     *  routing (chat LLM provider and fixer CLI). */
    chatAgent?: string;
    editingAgent?: string;
    /** Mirrors the JWT's `isAnonymous` claim — set at connect time. Anon
     *  sessions are allowed in the editor but blocked from CLI-spawning
     *  paths (CREATE_GAME, FIX_GAME) and publishing. */
    isAnonymous: boolean;
    /** Set by the FIX_GAME commit paths (direct fixer + LLM tool) when a
     *  successful commit wrote a pending agent_feedback row. Fired as a
     *  `feedback_required` WS event at end-of-turn so the form doesn't
     *  cover the AI's still-streaming reply. Cleared on announce. */
    pendingFeedbackAnnounceId: number | null;
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
// Touches updated_at so any chat turn bumps the project to the top of
// the project list (which sorts updated_at DESC). Uses the same
// subsecond-precision format as the rest of the codebase (see
// routes/projects.ts) so chat-only bumps sort correctly against edits.
const stmtTouchProject = db.prepare("UPDATE projects SET updated_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?");
const stmtInsertMessage = db.prepare("INSERT INTO chat_messages (project_id, chat_session_id, role, content, file_changes, project_data_snapshot, project_data_before, offer_create_game_description) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const stmtSetLastChatSession = db.prepare('UPDATE projects SET last_chat_session_id = ? WHERE id = ?');
const stmtGetHistory = db.prepare("SELECT id, role, content, feedback, file_changes, offer_create_game_description, created_at FROM chat_messages WHERE project_id = ? AND chat_session_id = ? ORDER BY id ASC");
const stmtSetFeedback = db.prepare("UPDATE chat_messages SET feedback = ? WHERE id = ? AND project_id = ?");
const stmtGetMessage = db.prepare("SELECT * FROM chat_messages WHERE id = ? AND project_id = ?");
const stmtDeleteAfter = db.prepare("DELETE FROM chat_messages WHERE project_id = ? AND chat_session_id = ? AND id > ?");
const stmtRecentChat = db.prepare("SELECT role, content FROM chat_messages WHERE project_id = ? AND chat_session_id = ? ORDER BY id DESC LIMIT 20");

function getRecentChatHistory(projectId: string, chatSessionId: string): string {
    try {
        const rows = stmtRecentChat.all(projectId, chatSessionId) as Array<{ role: string; content: string }>;
        if (rows.length === 0) return '';
        rows.reverse();
        const lines: string[] = [];
        for (const r of rows) {
            let text = (r.content || '').trim();
            if (!text) continue;
            // Strip internal system instructions
            text = text.replace(/\[SYSTEM\].*$/s, '').trim();
            // Strip tool tags (<<<LOAD_TEMPLATE>>>, <<<CREATE_GAME>>>, etc.)
            text = text.replace(/<<<[^>]*>>>/g, '').trim();
            // Strip { } thinking blocks from assistant messages
            if (r.role === 'assistant') {
                text = text.replace(/\{[^}]*\}/g, '').trim();
            }
            if (!text) continue;
            const label = r.role === 'user' ? 'User' : 'Assistant';
            lines.push(`**${label}:** ${text.slice(0, 500)}`);
        }
        return lines.join('\n\n');
    } catch { return ''; }
}
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

// Recorded once at module load. Used to tag the first 60s of post-restart
// connections with a system_updated message so the editor can show a quick
// "engine updated" toast — the user's natural signal that their disconnect
// was a hotfix, not a crash.
const BACKEND_BOOTED_AT = Date.now();
const POST_BOOT_BROADCAST_WINDOW_MS = 60_000;

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
        // Restore the chat session the user was last on, so refresh
        // doesn't lose their context. Preference order:
        //  1. projects.last_chat_session_id — the user's explicit
        //     choice (set by switch_chat_session / new_chat_session /
        //     first message). This is THE correct answer once any
        //     session has ever been touched.
        //  2. Most recent chat_messages row for this user on this
        //     project — fallback for projects from before the
        //     last_chat_session_id column existed.
        //  3. Mint a fresh session id — brand-new project, no history.
        const sessionPrefix = `u${user.id}_`;
        let chatSessionId = (row as any).last_chat_session_id as string | null;
        // Defensive: if the stored id is somehow for a different user
        // (impossible today since projects are single-user, but future-
        // proofing), ignore it and fall through.
        if (chatSessionId && !chatSessionId.startsWith(sessionPrefix)) {
            chatSessionId = null;
        }
        if (!chatSessionId) {
            const mostRecent = db.prepare(
                "SELECT chat_session_id FROM chat_messages WHERE project_id = ? AND chat_session_id LIKE ? ORDER BY id DESC LIMIT 1"
            ).get(projectId, sessionPrefix + '%') as { chat_session_id?: string } | undefined;
            chatSessionId = mostRecent?.chat_session_id || null;
        }
        if (!chatSessionId) {
            chatSessionId = `u${user.id}_p${projectId.slice(0, 8)}_${randomUUID()}`;
        }
        // Keep the column in sync with whatever we just decided so the
        // next refresh lands on the same session — covers the fallback
        // + mint paths; the explicit switch/new handlers write it too.
        if ((row as any).last_chat_session_id !== chatSessionId) {
            try { stmtSetLastChatSession.run(chatSessionId, projectId); } catch {}
        }
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
            jobUnsubscribe: null,
            isAnonymous: !!user.isAnonymous,
            pendingFeedbackAnnounceId: null,
        };

        clients.set(clientId, client);

        // Project is locked by an active generation job. Tell the frontend
        // to bounce back to the project list (that's where the user will
        // watch progress) and subscribe this client to live status events
        // so any still-open tab updates before it navigates away.
        const genState = readGenerationState(projectId);
        if (genState.active) {
            send(client, 'editor_locked', {
                projectId,
                reason: 'generation',
                jobId: genState.jobId,
                startedAt: genState.startedAt,
                description: genState.description,
                lastStatus: genState.lastStatus,
            });
            const unsub = subscribeToJob(projectId, (event) => {
                if (event.type === 'status') {
                    send(client, 'generation_status', { text: event.text });
                } else if (event.type === 'queue_position') {
                    send(client, 'generation_queue', event.queuePosition);
                } else if (event.type === 'complete') {
                    send(client, 'generation_complete', { status: event.status, summary: event.summary });
                }
            });
            if (unsub) client.jobUnsubscribe = unsub;
        }

        // Plugin connection hooks
        for (const p of _plugins) {
            if (p.onWsConnection) p.onWsConnection(client);
        }

        // Post-restart signal: any client that reconnects within 60s of
        // boot gets told the engine just updated. Editor shows a brief
        // "engine updated" banner — enough user feedback that the blip
        // was intentional, not a crash.
        if (Date.now() - BACKEND_BOOTED_AT < POST_BOOT_BROADCAST_WINDOW_MS) {
            send(client, 'system_updated', {});
        }

        // Pending agent-feedback — shown in the chat panel as a form
        // until the user submits (or dismisses, for fix_game). Fires
        // on every connect so a refresh re-prompts if they dismissed.
        // Only fires when the underlying CLI run actually completed
        // successfully — aborted / failed runs don't write a pending
        // row (guarded in generation_jobs + runDirectFixer + executor).
        try {
            const pending = getPendingFeedback(client.projectId);
            if (pending) {
                send(client, 'feedback_required', {
                    feedbackId: pending.id,
                    kind: pending.kind,
                    prompt: pending.prompt,
                    createdAt: pending.createdAt,
                });
            }
        } catch (e: any) {
            console.error('[Feedback] pending check failed:', e?.message);
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
            isAnonymous: client.isAnonymous,
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
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [], offerCreateGameDescription: m.offer_create_game_description || null })),
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
            //
            // This AbortController only covers per-request work bound to
            // THIS WS client (fixer, chat streaming, direct-fixer). A
            // CREATE_GAME background job lives in generation_jobs with
            // its own AbortController and is deliberately immune here —
            // the whole point of the new flow is that it outlives the
            // tab.
            if (client.abortController) {
                client.abortController.abort();
                client.abortController = null;
            }
            // Unsubscribe from the generation job's progress stream (if
            // any) — but do NOT abort the job itself. The only way to
            // kill a generation is the explicit `stop_generation` message
            // or the project-list STOP button.
            if (client.jobUnsubscribe) {
                client.jobUnsubscribe();
                client.jobUnsubscribe = null;
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
            // Remember this as the session to restore on next refresh.
            try { stmtSetLastChatSession.run(newSessionId, client.projectId); } catch {}
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
            // Remember the explicit switch so a later refresh restores
            // this session instead of whichever one has the most
            // recent message.
            try { stmtSetLastChatSession.run(sessionId, client.projectId); } catch {}
            const history = stmtGetHistory.all(client.projectId, sessionId) as any[];
            send(client, 'chat_history', {
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [], offerCreateGameDescription: m.offer_create_game_description || null })),
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
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [], offerCreateGameDescription: m.offer_create_game_description || null })),
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
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [], offerCreateGameDescription: m.offer_create_game_description || null })),
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
                messages: history.map(m => ({ id: m.id, role: m.role, content: m.content, feedback: m.feedback || null, fileChanges: m.file_changes ? JSON.parse(m.file_changes) : [], offerCreateGameDescription: m.offer_create_game_description || null })),
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

        // Kill the background CREATE_GAME job for this project. Distinct
        // from `stop_generation` (which aborts only the per-client chat
        // stream) — this reaches into generation_jobs and SIGTERMs the
        // CLI process behind the build, regardless of which client
        // started it. Exposed so the project-list STOP button works.
        case 'stop_generation_job': {
            const aborted = abortJob(client.projectId);
            send(client, 'generation_job_stop_ack', { aborted });
            break;
        }

        // User clicked the "Create from scratch" button the AI offered
        // with OFFER_CREATE_GAME. Kick off the background build directly
        // — no extra AI turn needed. Same shape as the executor's
        // CREATE_GAME path: start the job, persist synthetic chat
        // history entries so the turn reads naturally when the user
        // returns, then tell the client to bounce to the project list.
        case 'confirm_create_game':
            handleConfirmCreateGame(client, data);
            break;

        // User rated the most recent CREATE_GAME / FIX_GAME run in the
        // feedback form that replaced the chat panel on connect.
        // Resolution= 'submitted' unless they dismissed a FIX_GAME row.
        case 'feedback_submit':
            handleFeedbackSubmit(client, data);
            break;

        case 'feedback_dismiss':
            handleFeedbackDismiss(client, data);
            break;

        // CREATE_GAME revert — user didn't like the build, wants their
        // prior project back. Rolls project_data to the agent_feedback
        // row's project_before snapshot + resolves the row 'reverted'.
        case 'feedback_revert':
            handleFeedbackRevert(client, data);
            break;

        case 'file_save':
            if (isProjectLocked(client.projectId)) {
                send(client, 'file_save_error', { path: data?.path, error: 'Project is locked — a CREATE_GAME build is in progress.' });
                break;
            }
            handleFileSave(client, data);
            break;

        case 'project_save':
            if (isProjectLocked(client.projectId)) {
                send(client, 'project_saved', { success: false, error: 'Project is locked — a CREATE_GAME build is in progress.' });
                break;
            }
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

/**
 * Runs every plugin's checkLLMBudget hook (hosted usage plugin is the
 * only one that implements it today) and returns the refusal message
 * if the user is over their cap. Null when everyone allows. Used to
 * gate all the paths that actually cost money: LLM chat, direct
 * fixer, CREATE_GAME via LLM tool, CREATE_GAME via button.
 */
async function checkBudgetOrBlock(client: EditorClient): Promise<string | null> {
    for (const p of _plugins) {
        if (!p.checkLLMBudget) continue;
        const budget = await p.checkLLMBudget(client);
        if (!budget.allowed) {
            // Budget refusals flagged as signup-required (anon tier)
            // also emit the same WS event CLI-refusals use, so the
            // chat renders the inline signup bubble with the button.
            // The returned error text still runs through finishChat as
            // a normal assistant message — matches the CLI path.
            if (budget.signupRequired) {
                send(client, 'signup_required', {
                    feature: 'BUDGET',
                    message: budget.error || 'Sign up free to keep going.',
                });
            }
            return budget.error || 'Token usage limit reached. Upgrade your plan or wait until next month.';
        }
    }
    return null;
}

/**
 * User submitted the feedback form that replaced the chat panel on
 * connect. Resolves the pending row + triggers an AI follow-up turn
 * that acknowledges the rating (thanks on thumbs-up, apology +
 * fix offer on thumbs-down). Only runs on a successful underlying
 * CLI run — by design, aborted / failed runs never write a pending
 * feedback row in the first place.
 */
function handleFeedbackSubmit(client: EditorClient, data: any): void {
    const feedbackId = Number(data?.feedbackId);
    const rating = typeof data?.rating === 'string' ? data.rating : '';
    const text = typeof data?.text === 'string' ? data.text.slice(0, 4000) : '';
    if (!Number.isFinite(feedbackId) || feedbackId <= 0) {
        send(client, 'feedback_submit_error', { error: 'Invalid feedback id.' });
        return;
    }
    if (rating !== 'up' && rating !== 'down') {
        send(client, 'feedback_submit_error', { error: 'Rating must be up or down.' });
        return;
    }
    const row = getFeedbackById(feedbackId);
    if (!row || row.project_id !== client.projectId || row.user_id !== client.userId) {
        send(client, 'feedback_submit_error', { error: 'Feedback not found.' });
        return;
    }
    if (row.resolved_at) {
        // Already resolved from another tab — ack quietly so this
        // client's UI unlocks too.
        send(client, 'feedback_submitted', { feedbackId });
        return;
    }
    resolveFeedback(feedbackId, 'submitted', rating, text || null);
    send(client, 'feedback_submitted', { feedbackId });

    // Save the feedback as a visible user chat message + kick off
    // an AI follow-up turn. The LLM sees this in context with the
    // system prompt's "respond to feedback" guidance and replies
    // with a thanks / apology + offer to fix. Chat stays usable
    // from here on.
    const label = row.kind === 'create_game' ? 'the build' : 'the last change';
    const ratingText = rating === 'up' ? 'It worked' : 'It did not work';
    const lines = [
        `**Feedback on ${label}** — ${ratingText}.`,
        '',
        `> Original request: ${row.prompt || '(not captured)'}`,
    ];
    if (text) {
        lines.push('', `Notes: ${text}`);
    }
    lines.push(
        '',
        '[SYSTEM] This is user feedback on a completed build/fix — NOT a new request. ' +
        'Do NOT call LOAD_TEMPLATE, CREATE_GAME, FIX_GAME, or any other tool. ' +
        'Just reply in a { } block: thank them, acknowledge their feedback, ' +
        'and if the rating was negative offer to help fix specific issues.',
    );
    const content = lines.join('\n');
    const snapshot = getProjectSnapshot(client.projectId);
    stmtInsertMessage.run(
        client.projectId, client.chatSessionId, 'user', content,
        null, null, snapshot, null,
    );
    stmtTouchProject.run(client.projectId);
    send(client, 'chat_response_start', {});

    const abortController = new AbortController();
    client.abortController = abortController;
    runLLMWithRetry(client, abortController, 0, [], []);
}

/**
 * Hard dismiss — only valid for fix_game. CREATE_GAME is strict per
 * product spec (a 20-minute build deserves at least a rating).
 * Marks the row resolved with resolution='dismissed' so it stays out
 * of getPendingFeedback on future connects and the form doesn't
 * come back.
 */
function handleFeedbackDismiss(client: EditorClient, data: any): void {
    const feedbackId = Number(data?.feedbackId);
    if (!Number.isFinite(feedbackId) || feedbackId <= 0) return;
    const row = getFeedbackById(feedbackId);
    if (!row || row.project_id !== client.projectId || row.user_id !== client.userId) return;
    if (row.kind === 'create_game') {
        send(client, 'feedback_dismiss_rejected', {
            feedbackId,
            reason: 'CREATE_GAME feedback cannot be dismissed — quick rating required.',
        });
        return;
    }
    if (!row.resolved_at) {
        resolveFeedback(feedbackId, 'dismissed', null, null);
    }
    send(client, 'feedback_dismissed', { feedbackId });
}

/**
 * Roll the project back to its pre-CREATE_GAME state. The
 * agent_feedback row stores project_before as an inline JSON
 * snapshot at build-commit time, so we just write it back into
 * projects.project_data + rebuild. Row gets resolution='reverted'
 * so the analysis export can tell "user hit restore" apart from
 * a plain thumbs-down.
 *
 * CREATE_GAME only — FIX_GAME turns are already reachable via the
 * per-message "Revert to before" button in the chat footer.
 */
function handleFeedbackRevert(client: EditorClient, data: any): void {
    const feedbackId = Number(data?.feedbackId);
    const text = typeof data?.text === 'string' ? data.text.slice(0, 4000) : '';
    if (!Number.isFinite(feedbackId) || feedbackId <= 0) {
        send(client, 'feedback_revert_error', { error: 'Invalid feedback id.' });
        return;
    }
    const row = getFeedbackById(feedbackId);
    if (!row || row.project_id !== client.projectId || row.user_id !== client.userId) {
        send(client, 'feedback_revert_error', { error: 'Feedback not found.' });
        return;
    }
    if (row.kind !== 'create_game') {
        send(client, 'feedback_revert_error', {
            error: 'Revert only available for CREATE_GAME feedback.',
        });
        return;
    }
    if (!row.project_before) {
        send(client, 'feedback_revert_error', {
            error: 'No pre-build snapshot stored on this feedback row.',
        });
        return;
    }
    if (row.resolved_at) {
        // Idempotent — already handled from another tab. Just
        // ack so this client's UI unlocks.
        send(client, 'feedback_submitted', { feedbackId });
        return;
    }
    let parsed: ProjectData;
    try {
        parsed = parseProjectData(row.project_before);
    } catch (e: any) {
        send(client, 'feedback_revert_error', { error: `Snapshot parse failed: ${e?.message}` });
        return;
    }
    if (isLegacyProjectData(parsed)) {
        send(client, 'feedback_revert_error', {
            error: 'Pre-build snapshot is in the legacy file shape; cannot restore.',
        });
        return;
    }
    // Commit the restore + push project_reload so the editor
    // re-renders from the restored state.
    stmtUpdateData.run(row.project_before, client.projectId);
    rebuildAndPush(client, parsed, { sceneKey: client.activeSceneKey });
    resolveFeedback(feedbackId, 'reverted', null, text || null);
    send(client, 'feedback_submitted', { feedbackId });

    // Same chat-surfacing shape as submit — save a user-voiced
    // message so the transcript reads "I reverted the build"
    // and kick off an AI follow-up turn. System prompt rule 13
    // already covers the thumbs-down apology path; the AI will
    // acknowledge the revert and ask what to try differently.
    const lines = [
        '**I reverted the build** — restored the project to how it was before CREATE_GAME.',
        '',
        `> Original request: ${row.prompt || '(not captured)'}`,
    ];
    if (text) lines.push('', `Notes: ${text}`);
    const content = lines.join('\n');
    const snapshot = getProjectSnapshot(client.projectId);
    stmtInsertMessage.run(
        client.projectId, client.chatSessionId, 'user', content,
        null, null, snapshot, null,
    );
    stmtTouchProject.run(client.projectId);
    send(client, 'chat_response_start', {});
    const abortController = new AbortController();
    client.abortController = abortController;
    runLLMWithRetry(client, abortController, 0, [], []);
}

async function handleConfirmCreateGame(client: EditorClient, data: any): Promise<void> {
    const description = typeof data?.description === 'string' ? data.description.trim() : '';
    if (!description) {
        send(client, 'create_game_offer_error', { error: 'Missing description — the button click had no game brief attached.' });
        return;
    }

    // Anonymous users can't trigger CREATE_GAME — it spawns a CLI for
    // tens of minutes and costs real money. Editor catches this event
    // and surfaces a sign-up modal.
    if (client.isAnonymous) {
        send(client, 'signup_required', {
            feature: 'CREATE_GAME',
            message: 'Sign up free to build a game from scratch — your prompt and any work-in-progress will follow you to your new account.',
        });
        return;
    }

    // Budget gate — button-click path bypasses the chat LLM which
    // normally gates usage, so enforce here too. Refuses before we
    // insert synthetic history entries (don't want a fake "yes" sitting
    // in the log for a build that never started).
    const blockedByBudget = await checkBudgetOrBlock(client);
    if (blockedByBudget) {
        send(client, 'create_game_offer_error', { error: blockedByBudget });
        return;
    }

    // Stash synthetic chat messages so the turn reads naturally when the
    // user comes back to the chat history later. Stored as "user: yes,
    // build it from scratch" + "assistant: starting the build" — without
    // this, the history reads "AI asked → (nothing) → jump to results".
    const SYNTHETIC_USER_MSG = 'Yes — build it from scratch (via button).';
    const beforeSnapshot = getProjectSnapshot(client.projectId);
    stmtInsertMessage.run(
        client.projectId, client.chatSessionId, 'user',
        SYNTHETIC_USER_MSG,
        null, null, beforeSnapshot, null,
    );

    try {
        const jobId = await startGenerationJob({
            projectId: client.projectId,
            userId: client.userId,
            username: client.username,
            authToken: client.authToken,
            description,
            cliOverride: client.editingAgent,
            chatHistory: getRecentChatHistory(client.projectId, client.chatSessionId),
        });
        send(client, 'generation_started', {
            jobId,
            projectId: client.projectId,
            startedAt: new Date().toISOString(),
            description,
        });
        // Persist a friendly confirmation message so the chat history
        // looks intentional on return.
        const assistantMsg = 'Starting the background build. You can safely close your browser — we\'ll let you know when it\'s ready.';
        const snapshotAfter = getProjectSnapshot(client.projectId);
        stmtInsertMessage.run(
            client.projectId, client.chatSessionId, 'assistant',
            assistantMsg, null, snapshotAfter, null, null,
        );
        // Mirror the synthetic turn into the JSONL log so the admin
        // Chat Logs tab sees parity with DB-backed history. Append
        // both entries together so sessions that start with the
        // button click aren't empty files.
        appendToLog(client.projectId, client.chatSessionId, { role: 'user', content: SYNTHETIC_USER_MSG });
        appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: assistantMsg });
    } catch (e: any) {
        send(client, 'create_game_offer_error', { error: e?.message || 'Failed to start build.' });
        // Drop the synthetic user message — the fake "yes" is misleading
        // history if the job never actually started. DELETE with
        // ORDER BY + LIMIT isn't portable in SQLite, so look up the id
        // first then delete by it.
        const row = db.prepare(
            `SELECT id FROM chat_messages WHERE project_id = ? AND chat_session_id = ? AND role = 'user' AND content = ? ORDER BY id DESC LIMIT 1`,
        ).get(client.projectId, client.chatSessionId, SYNTHETIC_USER_MSG) as { id: number } | undefined;
        if (row?.id) {
            db.prepare('DELETE FROM chat_messages WHERE id = ?').run(row.id);
        }
    }
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

/**
 * Validate-then-commit gate for chat-driven file edits (direct fixer +
 * LLM FIX_GAME path).
 *
 * Historically the commit path wrote to the DB first, then ran buildProject.
 * If assembleGame rejected the result (missing reference, FSM-reserved key
 * collision, orphan inline onclick, etc.) the DB was already corrupt, the
 * editor received `build_error`, and the user saw a half-fixed project
 * that their "chat said it was fixed" claim contradicted. Reproduced by
 * prim15505 on 2026-04-19 with the fps_shooter → offline conversion:
 * 04_systems.json got rewritten to point at a new offline_deathmatch.ts
 * that the agent never actually wrote, the DB committed, the build failed,
 * the user deleted the project and started over.
 *
 * Now we build against the candidate files BEFORE writing. On success,
 * commit + push `project_reload` as before. On failure, skip the DB
 * write entirely, send `fix_rolled_back` so the editor can surface it
 * in-chat, and defensively re-push the current DB state as `project_reload`
 * so any drifted in-memory state snaps back to server truth.
 */
function commitProjectFilesWithValidation(
    client: EditorClient,
    pd: ProjectData,
    opts: { sceneKey: string },
): BuildResult {
    const built = buildProject(client.projectId, pd.files, { activeSceneKey: opts.sceneKey });
    if (!built.success) {
        send(client, 'fix_rolled_back', { error: built.error });
        // Re-push whatever the DB currently holds — should still be the
        // pre-fix state since we bailed before stmtUpdateData. Snaps the
        // editor back to server truth belt-and-suspenders.
        const current = readProjectData(client.projectId);
        if (current) {
            const recovery = buildProject(client.projectId, current.files, { activeSceneKey: opts.sceneKey });
            if (recovery.success) {
                const sceneData = recovery.scenes[opts.sceneKey] || recovery.scenes[recovery.activeSceneKey];
                send(client, 'project_reload', {
                    sceneKey: recovery.activeSceneKey,
                    sceneData,
                    scripts: recovery.scripts,
                    uiFiles: recovery.uiFiles,
                    sourceMap: recovery.sourceMap,
                });
            }
        }
        return built;
    }
    stmtUpdateData.run(serializeProjectData(pd), client.projectId);
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

const MAX_RETRIES = 7;

function handleChatMessage(client: EditorClient, data: any): void {
    const content = data?.content;
    if (!content || typeof content !== 'string') return;

    // Refuse any chat work while the project is being rebuilt from
    // scratch — the CLI creator owns the whole file tree for the
    // duration, and an interleaved FIX_GAME or EDIT would race it.
    if (isProjectLocked(client.projectId)) {
        send(client, 'chat_response_start', {});
        finishChat(
            client,
            '*A CREATE_GAME build is currently running for this project. Wait for it to finish — you\'ll be notified — or stop it from the project list before editing.*',
        );
        return;
    }

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
    stmtInsertMessage.run(client.projectId, client.chatSessionId, 'user', content, null, null, beforeSnapshot, null);
    // Bump updated_at on every chat turn — even ones that end up making
    // no file changes — so the project moves to the top of the list as
    // soon as the user starts a conversation.
    stmtTouchProject.run(client.projectId);
    send(client, 'chat_response_start', {});

    const abortController = new AbortController();
    client.abortController = abortController;

    // Agent override: when the user explicitly picks a CLI agent in the UI
    // we skip the small LLM entirely and hand the raw message to the CLI
    // fixer. This is the "direct" path — best for concrete fix/feature asks.
    const agent = typeof data?.agent === 'string' ? data.agent : '';
    if (agent === 'claude' || agent === 'codex' || agent === 'opencode' || agent === 'copilot') {
        // Anon sessions can't invoke a CLI directly — same rule as
        // CREATE_GAME and the LLM's FIX_GAME tool. Nudge to sign up.
        if (client.isAnonymous) {
            send(client, 'signup_required', {
                feature: 'FIX_GAME',
                message: 'Sign up free to unlock more features. Your project will follow you over.',
            });
            finishChat(client, '*Sign up to unlock more features — your project will follow you over.*');
            return;
        }
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
    // Admin chat-logs parity with runLLMWithRetry: the direct-agent
    // path previously skipped the .jsonl log entirely, so whole sessions
    // were invisible to the Chat Logs tab. Log the prompt up-front; we
    // log the result (summary or error) right before every finishChat
    // call below so the transcript reads naturally end-to-end.
    appendToLog(client.projectId, client.chatSessionId, { role: 'user', content: description });
    try {
        // Budget gate — the direct-agent path skips the chat LLM (which
        // normally enforces the cap), so the user could otherwise keep
        // running the fixer indefinitely for free by picking an agent
        // in the dropdown. Enforce the same check here.
        const blockedByBudget = await checkBudgetOrBlock(client);
        if (blockedByBudget) {
            appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: blockedByBudget });
            finishChat(client, blockedByBudget);
            return;
        }

        const pd = readProjectData(client.projectId);
        if (!pd || isLegacyProjectData(pd)) {
            const msg = '*Project files unavailable — cannot run fixer.*';
            appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: msg });
            finishChat(client, msg);
            return;
        }

        const chatCtx = getRecentChatHistory(client.projectId, client.chatSessionId);
        const fixResult = await runFixer(
            client.projectId,
            description,
            pd.files,
            client.activeSceneKey,
            sendStatus,
            abortController.signal,
            cliOverride,
            chatCtx,
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
            const msg = '*Generation stopped.*';
            appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: msg });
            finishChat(client, msg);
            return;
        }

        const fileChanges: { path: string; type: string }[] = [];
        let validationRolledBack = false;
        let rollbackError = '';
        let fixBeforeSnapshot: string | null = null;
        let fixAfterSnapshot: string | null = null;
        if (fixResult.success && fixResult.filesChanged.length > 0) {
            const updates: Record<string, string | null> = {};
            for (const [k, v] of Object.entries(fixResult.changedFiles)) updates[k] = v;
            for (const k of fixResult.deletedFiles) updates[k] = null;
            const pd2 = readProjectData(client.projectId);
            if (pd2) {
                // Snapshot before applying the fix so the feedback export
                // can diff "what the user had" against "what the agent
                // produced". Inline blob — keeps agent_feedback rows
                // self-contained, no need to join chat_messages.
                fixBeforeSnapshot = serializeProjectData(pd2);
                for (const [filePath, cont] of Object.entries(updates)) {
                    if (cont === null) delete pd2.files[filePath];
                    else setFile(pd2, filePath, cont);
                }
                const built = commitProjectFilesWithValidation(client, pd2, { sceneKey: client.activeSceneKey });
                if (!built.success) {
                    validationRolledBack = true;
                    rollbackError = built.error || 'unknown build error';
                } else {
                    fixAfterSnapshot = serializeProjectData(pd2);
                }
            }
            if (!validationRolledBack) {
                for (const f of fixResult.filesChanged) {
                    const isDeleted = fixResult.deletedFiles.includes(f);
                    fileChanges.push({ path: f, type: isDeleted ? 'deleted' : 'modified' });
                }
            }
        }

        // Pending feedback row so the editor prompts the user on
        // next connect. Soft UX — the user can dismiss it, but the
        // row stays unresolved and re-fires until they actually
        // submit. Only fires on a committed change, not a rollback /
        // abort / failure — all three paths short-circuit above.
        if (!validationRolledBack && fixResult.success && fixResult.filesChanged.length > 0 && fixAfterSnapshot) {
            try {
                const fid = recordPendingFeedback({
                    userId: client.userId,
                    projectId: client.projectId,
                    kind: 'fix_game',
                    prompt: description,
                    projectBefore: fixBeforeSnapshot,
                    projectAfter: fixAfterSnapshot,
                });
                // Fire the feedback_required event once this chat turn
                // ends (see finishChat) so the form doesn't cover the
                // AI's still-streaming "I applied the fix" message.
                client.pendingFeedbackAnnounceId = fid;
            } catch (e: any) {
                console.error('[FIX_GAME] feedback record failed:', e?.message);
            }
        }

        if (validationRolledBack || !fixResult.success) {
            try {
                const reason = validationRolledBack
                    ? `Validation rollback: ${rollbackError}`
                    : (fixResult.summary || 'Fix failed');
                let failedAfter: string | null = null;
                if (fixBeforeSnapshot && fixResult.changedFiles && Object.keys(fixResult.changedFiles).length > 0) {
                    try {
                        const pd = parseProjectData(fixBeforeSnapshot);
                        if (!isLegacyProjectData(pd)) {
                            for (const [k, v] of Object.entries(fixResult.changedFiles)) setFile(pd, k, v);
                            for (const d of fixResult.deletedFiles) delete pd.files[d];
                            failedAfter = serializeProjectData(pd);
                        }
                    } catch {}
                }
                const fid = recordPendingFeedback({
                    userId: client.userId,
                    projectId: client.projectId,
                    kind: 'fix_game',
                    prompt: description,
                    projectBefore: fixBeforeSnapshot,
                    projectAfter: failedAfter,
                });
                resolveFeedback(fid, 'submitted', 'down', `[auto] ${reason}`);
            } catch (e: any) {
                console.error('[FIX_GAME] failed feedback record failed:', e?.message);
            }
        }

        const agentLabel = cliOverride === 'codex' ? 'Codex'
            : cliOverride === 'opencode' ? 'OpenCode'
            : cliOverride === 'copilot' ? 'GitHub Copilot'
            : 'Claude Code';
        let summary: string;
        if (validationRolledBack) {
            summary = `*${agentLabel} tried to apply a fix, but the resulting project didn't build: ${rollbackError}. No changes were applied — your project is back to how it was before this turn.*`;
        } else if (fixResult.success) {
            summary = fixResult.summary || `${agentLabel} applied the fix.`;
        } else {
            summary = `*${agentLabel} failed: ${fixResult.summary}*`;
        }
        appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: summary });
        finishChat(client, summary, validationRolledBack ? [] : fileChanges);
    } catch (e: any) {
        client.abortController = null;
        if (abortController.signal.aborted) {
            const msg = '*Generation stopped.*';
            appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: msg });
            finishChat(client, msg);
        } else {
            console.error('[DirectFixer] Error:', e?.message || e);
            const msg = `*Error: ${e?.message || 'Unknown error'}*`;
            appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: msg });
            finishChat(client, msg);
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
        commitFiles: (updates: Record<string, string | null>, feedback?: { kind: 'fix_game'; prompt: string }) => {
            const pd = readProjectData(client.projectId);
            if (!pd) return null;
            // Snapshot before applying the fix so recordPendingFeedback
            // (if the caller wants a row) gets a diffable before/after
            // pair without re-reading the DB mid-commit.
            const beforeSnapshot = feedback ? serializeProjectData(pd) : null;
            for (const [filePath, content] of Object.entries(updates)) {
                if (content === null) delete pd.files[filePath];
                else setFile(pd, filePath, content);
            }
            // Validate against the candidate file tree BEFORE writing to
            // DB. If assembleGame rejects it, the helper emits
            // fix_rolled_back, re-pushes server truth, and returns
            // { success: false }. The executor's FIX_GAME path sees that
            // and surfaces the rollback to the LLM's follow-up turn.
            const built = commitProjectFilesWithValidation(client, pd, { sceneKey: client.activeSceneKey });
            if (built.success && feedback && beforeSnapshot) {
                try {
                    const fid = recordPendingFeedback({
                        userId: client.userId,
                        projectId: client.projectId,
                        kind: feedback.kind,
                        prompt: feedback.prompt,
                        projectBefore: beforeSnapshot,
                        projectAfter: serializeProjectData(pd),
                    });
                    client.pendingFeedbackAnnounceId = fid;
                } catch (e: any) {
                    console.error('[FIX_GAME exec] feedback record failed:', e?.message);
                }
            }
            return built;
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
        userId: client.userId,
        username: client.username,
        authToken: client.authToken,
        activeSceneKey: client.activeSceneKey,
        editingAgent: client.editingAgent,
        isAnonymous: client.isAnonymous,
        chatHistory: getRecentChatHistory(client.projectId, client.chatSessionId),
    };
}

function finishChat(
    client: EditorClient,
    displayContent: string,
    fileChanges: any[] = [],
    opts?: { offerCreateGameDescription?: string },
): void {
    // Single terminal cleanup point for the in-flight abort handle. Nulling
    // anywhere else (mid-chain, between LLM stream end and tool execute,
    // etc.) breaks Stop mid-flow because the Stop handler short-circuits on
    // a null client.abortController.
    client.abortController = null;
    // Persist the terminal message to the admin chat-log jsonl. Without
    // this, fallback strings like the Sorry-we-failed message and the
    // Stop-pressed message only land in the DB + WebSocket — the chat
    // log would dead-end at the last raw LLM response, making sessions
    // that exhausted MAX_RETRIES look truncated in admin review.
    appendToLog(client.projectId, client.chatSessionId, { role: 'assistant', content: displayContent });
    // Save assistant message with post-edit snapshot
    const snapshot = getProjectSnapshot(client.projectId);
    const fileChangesJson = fileChanges.length > 0 ? JSON.stringify(fileChanges) : null;
    const offerDesc = opts?.offerCreateGameDescription || null;
    const dbResult = stmtInsertMessage.run(
        client.projectId, client.chatSessionId, 'assistant', displayContent,
        fileChangesJson, snapshot, null, offerDesc
    );
    send(client, 'chat_response_end', {
        fullContent: displayContent,
        messageId: Number(dbResult.lastInsertRowid),
        fileChanges,
        offerCreateGameDescription: offerDesc,
    });
    send(client, 'dialogue_done', {});

    // If a FIX_GAME commit this turn wrote a pending feedback row,
    // announce it now — the chat's already rendered its final message
    // so the form covering the chat won't hide a live stream. Clear
    // the flag so the submission's AI follow-up turn doesn't re-fire it.
    if (client.pendingFeedbackAnnounceId) {
        const fid = client.pendingFeedbackAnnounceId;
        client.pendingFeedbackAnnounceId = null;
        const row = getFeedbackById(fid);
        if (row && !row.resolved_at) {
            send(client, 'feedback_required', {
                feedbackId: row.id,
                kind: row.kind,
                prompt: row.prompt,
                createdAt: row.created_at,
            });
        }
    }
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

    const blockedByBudget = await checkBudgetOrBlock(client);
    if (blockedByBudget) {
        finishChat(client, blockedByBudget);
        return;
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
            finishChat(client, displayContent, allFileChanges, {
                offerCreateGameDescription: execResult.offerCreateGameDescription,
            });
        },
        onError: (error) => {
            client.abortController = null;
            finishChat(client, `*Error: ${error}*`);
        },
    }, abortController.signal, client.chatAgent);
}
