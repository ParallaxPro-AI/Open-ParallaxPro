/**
 * 010_generate_ground_type_map.ts
 *
 * Classifies the (extended-bbox) NAIP aerial imagery into per-pixel
 * ground-type weights and writes the runtime splatmap consumed by the
 * terrain shader.
 *
 * The splatmap is RGBA8 with one channel per ground layer:
 *   R = sand / beach      (layer 0)
 *   G = grass / vegetation (layer 1)
 *   B = grass-rock mix    (layer 2)
 *   A = rock / impervious (layer 3)
 * All-zero pixels (no NAIP coverage, e.g. open ocean) tell the shader to
 * fall back to its height+slope blending.
 *
 * Coordinate system: the splatmap is aligned 1:1 with the extended
 * heightmap (same bbox, same origin in world coords). The runtime maps
 * a world XZ position to splatmap UV via the heightmap's worldWidth/
 * worldDepth/origin — see terrain_texture_cache.ts.
 *
 * Inputs:
 *   ./preprocessed/naip_rgb.raw      RGB BIP, 3 bytes/pixel
 *   ./preprocessed/naip_meta.json    { width, height, bands, worldWidth, worldDepth, origin }
 *
 * Output:
 *   ../../reusable_assets/official/everything_game/terrain/
 *     ground_type_map.bin
 *     ground_type_map_meta.json
 *
 * Usage: npx tsx 010_generate_ground_type_map.ts
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREPROCESSED = path.join(__dirname, "preprocessed");
const TERRAIN_OUT = path.resolve(
    __dirname,
    "../../reusable_assets/official/everything_game/terrain"
);

interface NaipMeta {
    width: number;
    height: number;
    bands: number;
    worldWidth: number;
    worldDepth: number;
    origin: { x: number; z: number };
}

function smoothstep(edge0: number, edge1: number, x: number): number {
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
}

/**
 * Map a single RGB pixel to four layer weights (sand, grass, mix, rock).
 *
 * Returns null for "no data" (very bright, near-white pixels — typical of
 * NAIP no-coverage areas like open ocean) so the caller can leave the
 * splatmap zeroed there.
 */
function classifyPixel(r: number, g: number, b: number): [number, number, number, number] | null {
    // Near-white = no NAIP data. Leave zeroed so the shader falls back.
    if (r > 248 && g > 248 && b > 248) return null;

    const brightness = (r + g + b) / 3;

    // Very dark = water. Same fallback path (shader handles oceans via h<=0).
    if (brightness < 45) return null;

    const exg = 2 * g - r - b;                          // excess-green index
    const warmth = r - b;                                // brown/sand vs cool
    const saturation = Math.max(r, g, b) - Math.min(r, g, b);
    const grayness = 1 - saturation / (brightness + 1);

    const veg = smoothstep(5, 50, exg);
    const sand = smoothstep(10, 40, warmth)
               * smoothstep(130, 190, brightness)
               * (1 - veg)
               * smoothstep(-10, 5, -exg);
    const imperv = grayness
                 * smoothstep(50, 110, brightness)
                 * smoothstep(200, 170, brightness)
                 * (1 - veg)
                 * (1 - sand);
    const mix = smoothstep(-5, 15, exg)
              * (1 - smoothstep(15, 50, exg))
              * smoothstep(60, 100, brightness)
              * (1 - veg)
              * (1 - sand);

    let w0 = sand, w1 = veg, w2 = mix, w3 = imperv;
    let total = w0 + w1 + w2 + w3;
    if (total < 0.01) {
        // Ambiguous pixel — default to a gentle grass/rock mix so the
        // wilderness doesn't end up with all-zero (= height-fallback) holes
        // dotted through otherwise-classified terrain.
        if (brightness > 160) { w0 = 0.3; w2 = 0.7; }
        else                  { w2 = 0.5; w3 = 0.5; }
        total = w0 + w1 + w2 + w3;
    }
    return [w0 / total, w1 / total, w2 / total, w3 / total];
}

/** 3×3 box blur, weighted to ignore zero (no-data) neighbors. In-place not
 *  worth the saved alloc — this runs once per pipeline. */
function smoothNoDataAware(src: Uint8Array, w: number, h: number): Uint8Array {
    const out = new Uint8Array(src.length);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let s0 = 0, s1 = 0, s2 = 0, s3 = 0, count = 0;
            for (let dy = -1; dy <= 1; dy++) {
                const ny = Math.max(0, Math.min(h - 1, y + dy));
                for (let dx = -1; dx <= 1; dx++) {
                    const nx = Math.max(0, Math.min(w - 1, x + dx));
                    const i = (ny * w + nx) * 4;
                    if (src[i] | src[i + 1] | src[i + 2] | src[i + 3]) {
                        s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]; s3 += src[i + 3];
                        count++;
                    }
                }
            }
            const o = (y * w + x) * 4;
            if (count > 0) {
                out[o]     = Math.round(s0 / count);
                out[o + 1] = Math.round(s1 / count);
                out[o + 2] = Math.round(s2 / count);
                out[o + 3] = Math.round(s3 / count);
            }
            // else: stays 0 (no-data, falls back in shader)
        }
    }
    return out;
}

function main(): void {
    const metaPath = path.join(PREPROCESSED, "naip_meta.json");
    const rawPath = path.join(PREPROCESSED, "naip_rgb.raw");

    if (!fs.existsSync(rawPath) || !fs.existsSync(metaPath)) {
        console.error(`Missing NAIP preprocess output (${rawPath}).`);
        console.error("Run 001_map_gen/005_download_naip.sh + 002_world_gen/001_preprocess.sh first.");
        process.exit(1);
    }

    const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as NaipMeta;
    const W = meta.width, H = meta.height, bands = meta.bands;
    const naip = fs.readFileSync(rawPath);
    if (naip.length !== W * H * bands) {
        console.error(`NAIP size mismatch: expected ${W * H * bands} bytes, got ${naip.length}`);
        process.exit(1);
    }

    console.log(`=== Generate ground-type splatmap from NAIP (${W}x${H}) ===`);

    const classified = new Uint8Array(W * H * 4);
    let nVeg = 0, nSand = 0, nMix = 0, nImp = 0, nNo = 0;
    for (let i = 0; i < W * H; i++) {
        const r = naip[i * bands], g = naip[i * bands + 1], b = naip[i * bands + 2];
        const w = classifyPixel(r, g, b);
        if (!w) { nNo++; continue; }
        const o = i * 4;
        classified[o]     = Math.round(w[0] * 255);
        classified[o + 1] = Math.round(w[1] * 255);
        classified[o + 2] = Math.round(w[2] * 255);
        classified[o + 3] = Math.round(w[3] * 255);
        if (w[1] > 0.5)      nVeg++;
        else if (w[3] > 0.5) nImp++;
        else if (w[0] > 0.5) nSand++;
        else                 nMix++;
    }

    console.log("Smoothing classification boundaries...");
    const smoothed = smoothNoDataAware(classified, W, H);

    fs.mkdirSync(TERRAIN_OUT, { recursive: true });
    const binPath = path.join(TERRAIN_OUT, "ground_type_map.bin");
    const metaOutPath = path.join(TERRAIN_OUT, "ground_type_map_meta.json");
    fs.writeFileSync(binPath, smoothed);
    fs.writeFileSync(metaOutPath, JSON.stringify({
        width: W,
        height: H,
        channels: 4,
        layers: ["sand", "grass", "grass_rock", "rock_impervious"],
        // Geometry — splatmap is aligned 1:1 with the extended heightmap.
        worldWidth: meta.worldWidth,
        worldDepth: meta.worldDepth,
        origin: meta.origin,
    }, null, 2));

    const total = W * H;
    const pct = (n: number) => `${((n / total) * 100).toFixed(1)}%`;
    console.log("");
    console.log(`No-data:    ${nNo.toLocaleString().padStart(10)} (${pct(nNo)})`);
    console.log(`Vegetation: ${nVeg.toLocaleString().padStart(10)} (${pct(nVeg)})`);
    console.log(`Impervious: ${nImp.toLocaleString().padStart(10)} (${pct(nImp)})`);
    console.log(`Sand:       ${nSand.toLocaleString().padStart(10)} (${pct(nSand)})`);
    console.log(`Mixed:      ${nMix.toLocaleString().padStart(10)} (${pct(nMix)})`);
    console.log("");
    console.log(`Wrote ${binPath} (${(smoothed.length / 1e6).toFixed(1)} MB)`);
}

main();
