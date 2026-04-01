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

    /** Hook: called on server shutdown */
    onShutdown?: () => void;
}
