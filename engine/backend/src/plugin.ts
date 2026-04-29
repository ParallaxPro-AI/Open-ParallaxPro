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

    /** Hook: called before an LLM call to check if the user has budget. Return false to block.
     *  When `signupRequired` is true, the caller also emits a `signup_required`
     *  WS event so the editor renders the inline signup bubble (same UX as
     *  CREATE_GAME / FIX_GAME refusals). Used by the anonymous-tier cap. */
    checkLLMBudget?: (client: any) => Promise<{
        allowed: boolean;
        remaining?: number;
        error?: string;
        signupRequired?: boolean;
    }>;

    /** Hook: max concurrent CREATE_GAME jobs for a user. Return undefined to use default (1). */
    getMaxConcurrentCreates?: (userId: number) => number | undefined;

    /** Hook: called after server starts listening */
    onStartup?: () => void;

    /** Hook: called when a project is deleted */
    onProjectDelete?: (projectId: string, userId: number) => void;

    /** Hook: called when a project is created (prompt/template/empty).
     *  `prompt` is the user's typed game brief if they created via the
     *  prompt flow — null for empty/template flows. Hosted plugins use
     *  this to mirror the prompt into the landing-page admin tracker
     *  alongside hero-form submissions. */
    onProjectCreate?: (projectId: string, userId: number, username: string | null, prompt: string | null) => void;

    /** Hook: called when a background CREATE_GAME or FIX_GAME job settles
     *  (success, failure, abort). Hosted deployments use this to email
     *  the user (CREATE_GAME only), report token usage against their
     *  monthly cap, and archive a snapshot so admins can later clone the
     *  exact build that ran. Self-hosted plugins can ignore it.
     *
     *  `authToken` is the JWT captured when the job was started — valid for
     *  the whole 20–30 min run (JWTs are 7-day lived). When absent (self-
     *  hosted dev, non-WS-initiated jobs) plugins that need it should
     *  no-op gracefully.
     *
     *  `kind` distinguishes a from-scratch CREATE_GAME (full project
     *  rewrite, ~20–30 min, hosted email expected) from a mobile-
     *  background FIX_GAME (file-patch fix, no email). Plugins that send
     *  user-visible notifications should gate on kind === 'create'. */
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
        /** Absolute path to the admin-side CLI session capture dir, or null
         *  when capture was disabled/failed for this run. Admin-only — must
         *  never be surfaced to user-visible routes. */
        sessionCapturePath?: string | null;
        /** 'create' = CREATE_GAME (default for back-compat with existing
         *  hooks); 'fix' = mobile-background FIX_GAME. Hosted email plugin
         *  filters on this to skip emails for fix jobs. */
        kind?: 'create' | 'fix';
    }) => void;

    /** Hook: called on server shutdown */
    onShutdown?: () => void;

    /** Hook: called when the landing-side account-deletion flow asks the
     *  engine to wipe everything owned by `userId`. `projectIds` is the
     *  pre-computed list so plugins don't need to re-query. Plugins that
     *  store user-keyed rows (publish: published_games, game_likes, etc.)
     *  should clear them here. Core engine rows (projects, chat_messages,
     *  agent_feedback) are removed by the internal route after every
     *  plugin's hook returns. */
    onUserDelete?: (userId: number, projectIds: string[]) => Promise<void> | void;
}
