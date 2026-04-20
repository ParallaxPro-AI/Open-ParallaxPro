/**
 * Embedding service for semantic asset/library search.
 * Uses paraphrase-multilingual-MiniLM-L12-v2 via @xenova/transformers
 * (runs locally, no API key). Multilingual — handles Chinese, Thai,
 * Korean, etc. alongside English.
 */

import { pipeline, env } from '@xenova/transformers';
import type { FeatureExtractionPipeline } from '@xenova/transformers';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MODEL_CACHE_DIR = path.resolve(__dirname, '../.models_cache');
const EMBEDDINGS_CACHE_PATH = path.resolve(__dirname, '../.embeddings_cache.json');

env.cacheDir = MODEL_CACHE_DIR;

const MODEL_NAME = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const EMBEDDING_DIM = 384;

let extractor: FeatureExtractionPipeline | null = null;

interface EmbeddingsCache {
    version: number;
    fingerprint: string;
    embeddings: Record<string, number[]>;
}

export async function initEmbedder(): Promise<void> {
    extractor = await pipeline('feature-extraction', MODEL_NAME, { quantized: true }) as FeatureExtractionPipeline;
}

export function computeFingerprint(entries: { key: string; text: string }[]): string {
    const hash = crypto.createHash('sha256');
    hash.update(MODEL_NAME + '\n');
    const sorted = [...entries].sort((a, b) => a.key.localeCompare(b.key));
    for (const { key, text } of sorted) hash.update(key + '\0' + text + '\n');
    return hash.digest('hex');
}

export function loadCachedEmbeddings(fingerprint: string): Record<string, number[]> | null {
    if (!fs.existsSync(EMBEDDINGS_CACHE_PATH)) return null;
    try {
        const data: EmbeddingsCache = JSON.parse(fs.readFileSync(EMBEDDINGS_CACHE_PATH, 'utf-8'));
        if (data.version === 1 && data.fingerprint === fingerprint) return data.embeddings;
    } catch {}
    return null;
}

export function saveCachedEmbeddings(fingerprint: string, embeddings: Record<string, number[]>): void {
    fs.writeFileSync(EMBEDDINGS_CACHE_PATH, JSON.stringify({ version: 1, fingerprint, embeddings } satisfies EmbeddingsCache));
}

export async function embedText(text: string): Promise<number[]> {
    if (!extractor) throw new Error('Embedder not initialized');
    const output = await extractor(text, { pooling: 'mean', normalize: true });
    return Array.from(output.data as Float32Array).slice(0, EMBEDDING_DIM);
}

export async function embedTexts(texts: string[]): Promise<number[][]> {
    if (!extractor) throw new Error('Embedder not initialized');
    const results: number[][] = [];
    const BATCH_SIZE = 64;
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const output = await extractor(batch, { pooling: 'mean', normalize: true });
        const data = output.data as Float32Array;
        for (let j = 0; j < batch.length; j++) {
            results.push(Array.from(data.slice(j * EMBEDDING_DIM, (j + 1) * EMBEDDING_DIM)));
        }
    }
    return results;
}

export function cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot; // vectors are already normalized
}
