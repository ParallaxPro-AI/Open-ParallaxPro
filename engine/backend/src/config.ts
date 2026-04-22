import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../.env');

// .env is optional — every field has a default. If present we load it; if
// not, we fall through to process.env + the defaults below. Lets new users
// run the backend with zero configuration.
if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
}

function envString(key: string, fallback: string): string {
    return process.env[key] ?? fallback;
}

function envInt(key: string, fallback: number): number {
    const v = process.env[key];
    return v ? parseInt(v, 10) : fallback;
}

const DEV_JWT_SECRET = 'dev-secret';

export const config = {
    port: envInt('PORT', 3003),
    nodeEnv: envString('NODE_ENV', 'development'),
    isDev: envString('NODE_ENV', 'development') !== 'production',
    jwtSecret: envString('JWT_SECRET', DEV_JWT_SECRET),
    corsOrigins: process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(',').map(s => s.trim())
        : ['http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175'],
    assetsDir: envString('ASSETS_DIR', path.resolve(__dirname, '../../../reusable_assets')),
    assetsCdn: envString('ASSETS_CDN', 'https://parallaxpro.ai'),
    isHosted: !!process.env.WEBSITE_BACKEND_URL,
    // AI_BASE_URL / AI_MODEL / AI_API_KEY are optional. When any of the three
    // is missing, the backend falls back to driving a locally-installed CLI
    // agent (claude) for text completion — slower and less clean than a
    // direct API call, but gets you running without signing up for a key.
    ai: {
        baseUrl: envString('AI_BASE_URL', ''),
        model: envString('AI_MODEL', ''),
        apiKey: envString('AI_API_KEY', ''),
        maxTokens: envInt('AI_MAX_TOKENS', 8192),
    },
    fixer: {
        timeout: envInt('FIXER_TIMEOUT', 1200000),
    },
    // Phased creator pipeline (Approach B). When true, runCreator splits
    // CREATE_GAME into 5 sequential claude -p calls each with a narrow
    // CLAUDE.md. Aims for 50%+ cache_read reduction vs single-agent flow.
    // Off by default; user opts in via env var while we tune. Feature-flag
    // state is read once at module load; restart to flip.
    useCreatorPhased: envString('USE_CREATOR_PHASED', '0') === '1',
};

// Fail closed if a prod deploy forgot to set JWT_SECRET. Without this, the
// fallback above would silently keep using the public dev-secret and every
// issued JWT would be forgeable by anyone who read this file on GitHub.
if (!config.isDev && config.jwtSecret === DEV_JWT_SECRET) {
    throw new Error(
        'JWT_SECRET is unset in a NODE_ENV=production process. Refusing to boot. ' +
        'Set JWT_SECRET in the pm2 env to a long random string.'
    );
}
