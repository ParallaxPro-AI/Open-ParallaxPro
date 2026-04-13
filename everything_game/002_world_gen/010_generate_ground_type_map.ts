/**
 * 010_generate_ground_type_map.ts
 *
 * Classifies NAIP aerial imagery into terrain layer weights using RGB
 * color analysis (Excess Green Index, brightness, warmth).
 *
 * Output: terrain/ground_type_map.bin (4 bytes per pixel)
 *   R = sand/beach weight     (layer 0)
 *   G = grass/vegetation weight (layer 1)
 *   B = grass/rock mix weight  (layer 2)
 *   A = rock/impervious weight (layer 3)
 *
 * Where all channels = 0, the terrain shader falls back to elevation-based weights.
 *
 * Usage: npx tsx 010_generate_ground_type_map.ts
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PREPROCESSED = path.join(__dirname, "preprocessed");
const TERRAIN_DIR = path.resolve(
  __dirname,
  "../../reusable_assets/official/everything_game/terrain"
);

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function main() {
  console.log("=== Generate Ground Type Splatmap from NAIP ===");

  // Load NAIP raw RGB (BIP: R,G,B per pixel)
  const metaPath = path.join(PREPROCESSED, "naip_meta.json");
  const rawPath = path.join(PREPROCESSED, "naip_rgb.raw");

  if (!fs.existsSync(rawPath)) {
    console.error("Error: naip_rgb.raw not found.");
    console.error("  Run 001_map_gen/005_download_naip.sh + 001_preprocess.sh first.");
    process.exit(1);
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  const W = meta.width as number;
  const H = meta.height as number;
  const bands = meta.bands as number;
  console.log(`NAIP input: ${W}x${H}, ${bands} bands`);

  const naipBuf = fs.readFileSync(rawPath);
  console.log(`Raw data: ${(naipBuf.length / 1e6).toFixed(1)}MB`);

  // Output: 4 bytes per pixel (R=sand, G=grass, B=grass_rock, A=rock)
  const output = new Uint8Array(W * H * 4);

  let noDataCount = 0;
  let waterCount = 0;
  let vegCount = 0;
  let impervCount = 0;
  let sandCount = 0;
  let mixCount = 0;

  for (let i = 0; i < W * H; i++) {
    const r = naipBuf[i * bands];
    const g = naipBuf[i * bands + 1];
    const b = naipBuf[i * bands + 2];

    // No-data: white pixels (no NAIP coverage — ocean, edges)
    if (r > 248 && g > 248 && b > 248) {
      // All zeros → shader falls back to elevation-based
      noDataCount++;
      continue;
    }

    const brightness = (r + g + b) / 3;

    // Water: very dark pixels
    if (brightness < 45) {
      waterCount++;
      continue; // all zeros → elevation-based (water handled by shader)
    }

    // Classification indices
    const exg = 2 * g - r - b;     // Excess Green: -510 to 510
    const warmth = r - b;           // Warm (brown/sand) vs cool
    const saturation = (Math.max(r, g, b) - Math.min(r, g, b));

    // Vegetation factor: how green is this pixel?
    const vegFactor = smoothstep(5, 50, exg);

    // Sand/bare soil: warm, bright, low saturation green
    const sandFactor = smoothstep(10, 40, warmth) *
      smoothstep(130, 190, brightness) *
      (1 - vegFactor) *
      smoothstep(-10, 5, -exg);

    // Impervious/urban: grayish, medium brightness, not green
    const grayness = 1 - saturation / (brightness + 1);
    const impervFactor = grayness *
      smoothstep(50, 110, brightness) *
      smoothstep(200, 170, brightness) *
      (1 - vegFactor) *
      (1 - sandFactor);

    // Grass/rock mix: brownish-green transitions, hillside
    const mixFactor = smoothstep(-5, 15, exg) *
      (1 - smoothstep(15, 50, exg)) *
      smoothstep(60, 100, brightness);

    // Compute raw weights
    let w0 = sandFactor;
    let w1 = vegFactor;
    let w2 = mixFactor * (1 - vegFactor) * (1 - sandFactor);
    let w3 = impervFactor;

    // Normalize
    let total = w0 + w1 + w2 + w3;
    if (total < 0.01) {
      // Ambiguous pixel — assign based on brightness
      if (brightness > 160) {
        w0 = 0.3; w2 = 0.7; // bright but unclassified → sandy mix
      } else {
        w2 = 0.5; w3 = 0.5; // medium → grass/rock + rock
      }
      total = w0 + w1 + w2 + w3;
    }

    w0 /= total;
    w1 /= total;
    w2 /= total;
    w3 /= total;

    output[i * 4] = Math.round(w0 * 255);
    output[i * 4 + 1] = Math.round(w1 * 255);
    output[i * 4 + 2] = Math.round(w2 * 255);
    output[i * 4 + 3] = Math.round(w3 * 255);

    // Stats tracking
    if (w1 > 0.5) vegCount++;
    else if (w3 > 0.5) impervCount++;
    else if (w0 > 0.5) sandCount++;
    else mixCount++;
  }

  // Apply 3x3 box blur to smooth classification boundaries
  console.log("Smoothing classification boundaries...");
  const smoothed = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s0 = 0, s1 = 0, s2 = 0, s3 = 0, count = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = Math.max(0, Math.min(W - 1, x + dx));
          const ny = Math.max(0, Math.min(H - 1, y + dy));
          const idx = (ny * W + nx) * 4;
          // Only include non-zero pixels in the blur
          if (output[idx] + output[idx + 1] + output[idx + 2] + output[idx + 3] > 0) {
            s0 += output[idx];
            s1 += output[idx + 1];
            s2 += output[idx + 2];
            s3 += output[idx + 3];
            count++;
          }
        }
      }
      const idx = (y * W + x) * 4;
      if (count > 0) {
        smoothed[idx] = Math.round(s0 / count);
        smoothed[idx + 1] = Math.round(s1 / count);
        smoothed[idx + 2] = Math.round(s2 / count);
        smoothed[idx + 3] = Math.round(s3 / count);
      }
      // else: stays 0 (no-data)
    }
  }

  // Write output alongside the runtime heightmap bundle.
  fs.mkdirSync(TERRAIN_DIR, { recursive: true });

  const outPath = path.join(TERRAIN_DIR, "ground_type_map.bin");
  fs.writeFileSync(outPath, Buffer.from(smoothed.buffer));

  const outMeta = path.join(TERRAIN_DIR, "ground_type_map_meta.json");
  // Pass through the world-space placement from the NAIP meta so the
  // runtime can map splatmap UV → world XZ without re-reading the NAIP.
  fs.writeFileSync(outMeta, JSON.stringify({
    width: W,
    height: H,
    channels: 4,
    layers: ["sand", "grass", "grass_rock", "rock_impervious"],
    worldWidth: meta.worldWidth,
    worldDepth: meta.worldDepth,
    origin: meta.origin,
  }, null, 2));

  const totalPixels = W * H;
  console.log("");
  console.log("=== Ground Type Classification ===");
  console.log(`No-data (ocean/edge):  ${noDataCount.toLocaleString()} (${(noDataCount / totalPixels * 100).toFixed(1)}%)`);
  console.log(`Water:                 ${waterCount.toLocaleString()} (${(waterCount / totalPixels * 100).toFixed(1)}%)`);
  console.log(`Vegetation:            ${vegCount.toLocaleString()} (${(vegCount / totalPixels * 100).toFixed(1)}%)`);
  console.log(`Impervious/urban:      ${impervCount.toLocaleString()} (${(impervCount / totalPixels * 100).toFixed(1)}%)`);
  console.log(`Sand/bare:             ${sandCount.toLocaleString()} (${(sandCount / totalPixels * 100).toFixed(1)}%)`);
  console.log(`Mixed:                 ${mixCount.toLocaleString()} (${(mixCount / totalPixels * 100).toFixed(1)}%)`);
  console.log("");
  console.log(`Output: ${outPath} (${(smoothed.length / 1e6).toFixed(1)}MB)`);
}

main();
