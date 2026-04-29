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
    // Special case AI_* vars: on hosted prod, pm2 caches the env it captured
    // at first `pm2 start` (or via `pm2 save`/resurrect) and re-injects those
    // values on every restart — even with --update-env. Standard dotenv won't
    // overwrite them, so a .env edit gets shadowed by stale provider creds
    // (we burned hours on this with a Groq→OpenRouter swap). Force .env to
    // win for AI_* only — leaves PORT / NODE_ENV / etc. on standard
    // "explicit env wins" semantics so check_deploy and tests can still
    // pass PORT=3013 to spawn a sidecar backend without the .env's PORT
    // clobbering it.
    const envFile = dotenv.parse(fs.readFileSync(envPath));
    for (const key of Object.keys(envFile)) {
        if (key.startsWith('AI_')) process.env[key] = envFile[key];
    }
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
