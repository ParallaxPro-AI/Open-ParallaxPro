/**
 * Engine Plugin Interface — allows hosted versions to extend the engine
 * without modifying core code.
 */

import type { Express, RequestHandler } from 'express';
import type { WebSocketServer } from 'ws';
import type Database from 'better-sqlite3';

export interface AuthUser {
    id: number;
    email: string;
    username: string;
}

export interface EnginePlugin {
    /** Plugin name for logging */
    name: string;

    /** Register additional Express routes */
    registerRoutes?: (app: Express) => void;

    /** Register additional WebSocket upgrade paths */
    registerWebSocket?: (upgradeHandlers: Map<string, WebSocketServer>) => void;

    /** Override auth middleware for HTTP routes (replaces dev auth) */
    authMiddleware?: RequestHandler;

    /** Override WebSocket token verification */
    verifyWsToken?: (token: string) => AuthUser | null;

    /** Extend the database schema with additional tables */
    extendSchema?: (db: Database.Database) => void;

    /** Hook: called when a WebSocket client connects */
    onWsConnection?: (client: any) => void;

    /** Hook: called for each WebSocket message. Return true if handled (stops default processing) */
    onWsMessage?: (client: any, type: string, data: any) => boolean;

    /** Hook: called when a chat message is about to be processed */
    onChatMessage?: (client: any, content: string) => void;

    /** Hook: called after an LLM call with token usage info */
    onLLMUsage?: (client: any, usage: { promptTokens: number; completionTokens: number; totalTokens: number }) => void;

    /** Hook: called after a CLI fixer run with the USD cost */
    onFixerCost?: (client: any, costUsd: number) => void;

    /** Hook: called before an LLM call to check if the user has budget. Return false to block. */
    checkLLMBudget?: (client: any) => Promise<{ allowed: boolean; remaining?: number; error?: string }>;

    /** Hook: called after server starts listening */
    onStartup?: () => void;

    /** Hook: called when a project is deleted */
    onProjectDelete?: (projectId: string, userId: number) => void;

    /** Hook: called when a project is created (prompt/template/empty) */
    onProjectCreate?: (projectId: string, userId: number, username: string | null) => void;

    /** Hook: called when a background CREATE_GAME job settles (success, failure,
     *  abort). Hosted deployments use this to email the user, report token
     *  usage against their monthly cap, and archive a snapshot so admins
     *  can later clone the exact build that ran. Self-hosted plugins can
     *  ignore it.
     *
     *  `authToken` is the JWT captured when the job was started — valid for
     *  the whole 20–30 min run (JWTs are 7-day lived). When absent (self-
     *  hosted dev, non-WS-initiated jobs) plugins that need it should
     *  no-op gracefully. */
    onGenerationComplete?: (args: {
        projectId: string;
        projectName: string;
        userId: number;
        username?: string;
        authToken?: string;
        status: 'success' | 'failed' | 'aborted';
        summary: string;
        /** The original user-supplied build brief (prompt). */
        description: string;
        /** Epoch ms — when the job was accepted by generation_jobs. */
        startedAt: number;
        /** Epoch ms — when the hook fires (≈ end of the run). */
        endedAt: number;
        /** Which CLI agent actually ran (claude / codex / opencode / copilot). */
        cli: string;
        costUsd?: number;
    }) => void;

    /** Hook: called on server shutdown */
    onShutdown?: () => void;
}
