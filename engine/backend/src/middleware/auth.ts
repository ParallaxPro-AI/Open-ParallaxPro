import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import type { Request, Response, NextFunction } from 'express';

export interface AuthUser {
    id: number;
    email: string;
    username: string;
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
        req.user = { id: decoded.id, email: decoded.email, username: decoded.username };
        next();
    } catch {
        res.status(401).json({ error: 'Invalid token.' });
    }
}

export function verifyToken(token: string): AuthUser | null {
    try {
        return jwt.verify(token, config.jwtSecret) as AuthUser;
    } catch {
        return null;
    }
}
