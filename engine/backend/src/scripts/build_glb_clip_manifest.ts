#!/usr/bin/env node
/**
 * Pre-bake a JSON manifest of animation clip names for every GLB under
 * `reusable_assets/`. The output lives at
 * `engine/backend/data/glb_clip_manifest.json` (next to other static
 * asset metadata) and is consumed by:
 *   - the headless playtest's `animation_clip_resolves` invariant —
 *     statically validates that every `entity.playAnimation("X", …)`
 *     call references a clip that actually exists on the entity's GLB.
 *   - the CLI's `library.sh animations <asset_path>` subcommand —
 *     lets the agent ask "what clips does this character have?" before
 *     authoring.
 *
 * Why pre-baked vs. parsed at runtime: the headless harness runs in
 * Node without WebGPU and can't use the editor's loadGLB. A pre-baked
 * JSON is ~50KB for 3700 GLBs, loads in milliseconds, and is cheap to
 * regenerate after asset pack updates.
 *
 * Usage: npx tsx engine/backend/src/scripts/build_glb_clip_manifest.ts
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname_b = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname_b, '..', '..', '..', '..');
const ASSETS_DIR = path.join(REPO_ROOT, 'reusable_assets');
const OUT_PATH = path.join(REPO_ROOT, 'engine', 'backend', 'data', 'glb_clip_manifest.json');

interface ManifestEntry { clips: string[]; }

/** Parse a GLB's JSON chunk and return the names of every animation. */
function extractClipNames(filePath: string): string[] | null {
    let buf: Buffer;
    try { buf = fs.readFileSync(filePath); }
    catch { return null; }
    if (buf.length < 28) return null;
    // Header: 4-byte magic, 4-byte version, 4-byte total length.
    const magic = buf.toString('utf8', 0, 4);
    if (magic !== 'glTF') return null;
    const version = buf.readUInt32LE(4);
    if (version !== 2) return null;
    // First chunk: 4-byte length, 4-byte type ('JSON' = 0x4E4F534A LE).
    const chunk0Len = buf.readUInt32LE(12);
    const chunk0Type = buf.readUInt32LE(16);
    if (chunk0Type !== 0x4E4F534A) return null;  // not the expected JSON chunk
    const jsonStart = 20;
    const jsonEnd = jsonStart + chunk0Len;
    if (jsonEnd > buf.length) return null;
    let json: any;
    try { json = JSON.parse(buf.toString('utf8', jsonStart, jsonEnd)); }
    catch { return null; }
    const anims: any[] = json.animations;
    if (!Array.isArray(anims)) return [];
    const names: string[] = [];
    for (const a of anims) {
        if (typeof a?.name === 'string' && a.name.length > 0) names.push(a.name);
    }
    return names;
}

/** Walk reusable_assets/ for .glb files. Skips thumbnail / build dirs. */
function walkGLBs(dir: string, out: string[]): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === 'thumbnails' || e.name.startsWith('.')) continue;
            walkGLBs(full, out);
        } else if (e.isFile() && e.name.endsWith('.glb') && !e.name.endsWith('.lod1.bin') && !e.name.endsWith('.lod2.bin')) {
            out.push(full);
        }
    }
}

function main(): void {
    if (!fs.existsSync(ASSETS_DIR)) {
        console.error(`Assets dir not found: ${ASSETS_DIR}`);
        process.exit(1);
    }
    const glbs: string[] = [];
    walkGLBs(ASSETS_DIR, glbs);
    glbs.sort();

    const manifest: Record<string, ManifestEntry> = {};
    let totalClips = 0;
    let withClips = 0;
    let parseFailed = 0;
    for (const fullPath of glbs) {
        // Key by /assets/<rel_path> — matches how 02_entities.json
        // references mesh assets at runtime (the public URL form).
        const rel = path.relative(ASSETS_DIR, fullPath);
        const key = '/assets/' + rel.replace(/\\/g, '/');
        const clips = extractClipNames(fullPath);
        if (clips === null) { parseFailed++; continue; }
        manifest[key] = { clips };
        if (clips.length > 0) {
            withClips++;
            totalClips += clips.length;
        }
    }

    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 0) + '\n');
    const sizeKB = Math.round(fs.statSync(OUT_PATH).size / 1024);
    console.log(`Wrote ${OUT_PATH}`);
    console.log(`  GLBs scanned:      ${glbs.length}`);
    console.log(`  with animations:   ${withClips}`);
    console.log(`  total clips:       ${totalClips}`);
    console.log(`  parse failed:      ${parseFailed}`);
    console.log(`  manifest size:     ${sizeKB} KB`);
}

main();
