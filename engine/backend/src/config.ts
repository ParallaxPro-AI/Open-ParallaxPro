import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function envString(key: string, fallback: string): string {
    return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
    const v = process.env[key];
    return v ? parseInt(v, 10) : fallback;
}

const nodeEnv = envString('NODE_ENV', 'development');

export const config = {
    port: envInt('PORT', envInt('ENGINE_PORT', 3002)),
    nodeEnv,
    isDev: nodeEnv !== 'production',
    jwtSecret: envString('JWT_SECRET', 'dev-secret-change-in-production'),
    corsOrigins: process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
        : ['http://localhost:5173', 'http://localhost:5174'],
};

if (!config.isDev && config.jwtSecret === 'dev-secret-change-in-production') {
    console.warn('[Config] WARNING: Using default JWT_SECRET in production. Set JWT_SECRET env var.');
}
