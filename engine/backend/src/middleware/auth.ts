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

/** Mirror of TOKEN_EXPIRY in landing_page/backend/routes/auth.js. Keep in sync —
 *  the two services share the same JWT_SECRET so a refresh issued here is
 *  honored by every consumer. */
const TOKEN_EXPIRY = '90d';

interface DecodedJwt {
    id: number;
    email: string;
    username: string;
    isAnonymous?: boolean;
    iat?: number;
    exp?: number;
}

/** Set X-Refreshed-Token on the response when the incoming JWT is past
 *  the midpoint of its lifetime. Any authenticated request anywhere
 *  in the engine API counts as activity that bumps the user's expiry —
 *  active users effectively never sign in again. Mirrors the landing
 *  backend's maybeRefreshToken. */
function maybeRefreshToken(res: Response, decoded: DecodedJwt): void {
    if (typeof decoded.exp !== 'number' || typeof decoded.iat !== 'number') return;
    const now = Math.floor(Date.now() / 1000);
    const total = decoded.exp - decoded.iat;
    if (total <= 0) return;
    if (now - decoded.iat < total / 2) return;
    const payload: Record<string, unknown> = {
        id: decoded.id,
        email: decoded.email,
        username: decoded.username,
    };
    if (decoded.isAnonymous) payload.isAnonymous = true;
    const fresh = jwt.sign(payload, config.jwtSecret, { expiresIn: TOKEN_EXPIRY });
    res.setHeader('X-Refreshed-Token', fresh);
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
        const decoded = jwt.verify(token, config.jwtSecret) as DecodedJwt;
        req.user = {
            id: decoded.id,
            email: decoded.email,
            username: decoded.username,
            isAnonymous: !!decoded.isAnonymous,
        };
        maybeRefreshToken(res, decoded);
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
