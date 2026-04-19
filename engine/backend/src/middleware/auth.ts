import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { Request, Response, NextFunction } from 'express';

export interface AuthUser {
    id: number;
    email: string;
    username: string;
    // Set when the JWT was issued by /api/auth/anonymous on the landing
    // backend. Anonymous users can browse and chat but are blocked from
    // anything that spawns a CLI (CREATE_GAME, FIX_GAME) or publishes.
    // Enforce with requireRealUser on HTTP routes and handler-level
    // checks for WS-driven code paths.
    isAnonymous?: boolean;
}

declare global {
    namespace Express {
        interface Request {
            user?: AuthUser;
        }
    }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        if (config.isDev) {
            req.user = { id: 1, email: 'dev@local', username: 'dev' };
            next();
            return;
        }
        res.status(401).json({ error: 'Not authenticated.' });
        return;
    }

    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, config.jwtSecret) as AuthUser;
        req.user = {
            id: decoded.id,
            email: decoded.email,
            username: decoded.username,
            isAnonymous: !!decoded.isAnonymous,
        };
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token.' });
    }
}

/**
 * Run after requireAuth. Rejects anonymous sessions with a 402 + a
 * machine-readable reason so the editor can pop a "sign up to unlock"
 * modal instead of a generic error toast. Applied to CLI routes
 * (publish, CREATE_GAME trigger), not to plain chat or editor state
 * which anons are allowed to use up to their 100k-token cap.
 */
export function requireRealUser(req: Request, res: Response, next: NextFunction): void {
    if (!req.user) {
        res.status(401).json({ error: 'Not authenticated.' });
        return;
    }
    if (req.user.isAnonymous) {
        res.status(402).json({
            error: 'signup_required',
            message: 'Sign up for a free account to use this — it only takes a minute, and your work will follow you over.',
        });
        return;
    }
    next();
}

export function verifyToken(token: string): AuthUser | null {
    try {
        const decoded = jwt.verify(token, config.jwtSecret) as AuthUser;
        return {
            id: decoded.id,
            email: decoded.email,
            username: decoded.username,
            isAnonymous: !!decoded.isAnonymous,
        };
    } catch {
        return null;
    }
}
