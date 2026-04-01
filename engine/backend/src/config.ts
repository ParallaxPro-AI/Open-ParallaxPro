import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');

if (!fs.existsSync(envPath)) {
    console.error('[Config] .env file not found at ' + envPath);
    console.error('[Config] Copy .env.example to .env and fill in your values.');
    process.exit(1);
}

dotenv.config({ path: envPath });

function envRequired(key: string): string {
    const v = process.env[key];
    if (!v) {
        console.error(`[Config] Missing required env var: ${key}`);
        process.exit(1);
    }
    return v;
}

function envString(key: string, fallback: string): string {
    return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
    const v = process.env[key];
    return v ? parseInt(v, 10) : fallback;
}

export const config = {
    port: envInt('PORT', 3003),
    nodeEnv: envString('NODE_ENV', 'development'),
    isDev: envString('NODE_ENV', 'development') !== 'production',
    jwtSecret: envString('JWT_SECRET', 'dev-secret'),
    corsOrigins: process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
        : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
    assetsDir: envString('ASSETS_DIR', path.resolve(__dirname, '../../../reusable_assets')),
    ai: {
        baseUrl: envRequired('AI_BASE_URL'),
        model: envRequired('AI_MODEL'),
        apiKey: envRequired('AI_API_KEY'),
        maxTokens: envInt('AI_MAX_TOKENS', 8192),
    },
    fixer: {
        cli: envRequired('FIXER_CLI'),
        timeout: envInt('FIXER_TIMEOUT', 1200000),
    },
};
