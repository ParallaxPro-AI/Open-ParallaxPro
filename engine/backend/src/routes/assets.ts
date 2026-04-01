import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config.js';

const router = Router();

interface ScannedAsset {
    name: string;
    category: string;
    source: string;
    pack: string;
    filePath: string;
    extension: string;
    attribution?: string;
}

const CATEGORY_MAP: Record<string, string> = {
    '3d_models': '3D Models',
    'characters': 'Characters',
    'animations': 'Animations',
    'audio': 'Audio',
    'textures': 'Textures',
};

const CATEGORY_EXTENSIONS: Record<string, Set<string>> = {
    '3D Models': new Set(['glb', 'gltf', 'obj', 'fbx']),
    'Characters': new Set(['glb', 'gltf', 'obj', 'fbx']),
    'Animations': new Set(['json']),
    'Audio': new Set(['ogg', 'mp3', 'wav', 'flac']),
    'Textures': new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga']),
};

const SKIP_EXTENSIONS = new Set(['xml', 'json', 'txt', 'md']);

const assetsDir = config.assetsDir;
const thumbnailsDir = path.join(assetsDir, 'thumbnails');

// -- Scanning --

let assetCache: ScannedAsset[] = [];
const attributionCache = new Map<string, string>();

function scanAssets(): ScannedAsset[] {
    const results: ScannedAsset[] = [];
    if (!fs.existsSync(assetsDir)) return results;

    const sources = fs.readdirSync(assetsDir, { withFileTypes: true })
        .filter(d => d.isDirectory() && d.name !== 'thumbnails');

    for (const source of sources) {
        const sourcePath = path.join(assetsDir, source.name);
        const categories = fs.readdirSync(sourcePath, { withFileTypes: true })
            .filter(d => d.isDirectory());

        for (const cat of categories) {
            const displayCategory = CATEGORY_MAP[cat.name];
            if (!displayCategory) continue;
            scanDirectory(path.join(sourcePath, cat.name), source.name, displayCategory, path.join(sourcePath, cat.name), results);
        }
    }
    return results;
}

function scanDirectory(dir: string, source: string, category: string, categoryRoot: string, results: ScannedAsset[]): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    if (category === 'Textures') {
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            const texDir = path.join(dir, entry.name);
            const texFiles = fs.readdirSync(texDir);
            const diffFile = texFiles.find(f => (f.includes('_diff_') || f.includes('_diffuse_')) && /\.(jpg|png|jpeg)$/.test(f));
            if (!diffFile) continue;
            results.push({
                name: entry.name,
                category, source,
                pack: entry.name,
                filePath: path.relative(assetsDir, path.join(texDir, diffFile)),
                extension: path.extname(diffFile).replace('.', ''),
            });
        }
        return;
    }

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            scanDirectory(fullPath, source, category, categoryRoot, results);
        } else if (entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('_')) {
            const ext = path.extname(entry.name).toLowerCase().replace('.', '');
            const validExts = CATEGORY_EXTENSIONS[category];
            if (validExts ? !validExts.has(ext) : SKIP_EXTENSIONS.has(ext)) continue;

            const relToCat = path.relative(categoryRoot, fullPath);
            const parts = relToCat.split(path.sep);
            results.push({
                name: path.basename(entry.name, '.' + ext),
                category, source,
                pack: parts.length > 1 ? parts[0] : '',
                filePath: path.relative(assetsDir, fullPath),
                extension: ext,
            });
        }
    }
}

function scanAttributions(): void {
    if (!fs.existsSync(assetsDir)) return;
    const scan = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) scan(fullPath);
            else if (entry.name === 'ATTRIBUTION.txt') {
                try { attributionCache.set(path.relative(assetsDir, dir), fs.readFileSync(fullPath, 'utf8').trim()); } catch {}
            }
        }
    };
    scan(assetsDir);
}

function getAttribution(filePath: string): string | undefined {
    let dir = path.dirname(filePath);
    while (dir && dir !== '.') {
        const attr = attributionCache.get(dir);
        if (attr) return attr;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return undefined;
}

function getThumbnailUrl(filePath: string): string | null {
    const pngPath = path.join(thumbnailsDir, filePath.replace(/\.[^.]+$/, '.png'));
    if (fs.existsSync(pngPath)) return `/assets/thumbnails/${filePath.replace(/\.[^.]+$/, '.png')}`;
    const origPath = path.join(thumbnailsDir, filePath);
    if (fs.existsSync(origPath)) return `/assets/thumbnails/${filePath}`;
    return null;
}

function safePath(userPath: string): string | null {
    if (!userPath || userPath.includes('..') || userPath.includes('\0')) return null;
    const resolved = path.resolve(assetsDir, userPath);
    if (!resolved.startsWith(path.resolve(assetsDir) + path.sep) && resolved !== path.resolve(assetsDir)) return null;
    return resolved;
}

// Initial scan
scanAttributions();
assetCache = scanAssets();
for (const asset of assetCache) asset.attribution = getAttribution(asset.filePath);
console.log(`[Assets] ${assetCache.length} assets scanned`);

// -- Routes --

// List assets with filtering
router.get('/', (req: Request, res: Response): void => {
    const search = ((req.query.search ?? req.query.q) as string || '').toLowerCase();
    const category = (req.query.category as string) || '';
    const source = (req.query.source as string) || '';
    const pack = (req.query.pack as string) || '';
    const page = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit as string) || 60));

    let filtered = assetCache;
    if (category) filtered = filtered.filter(a => a.category === category);
    if (source) filtered = filtered.filter(a => a.source === source);
    if (pack) filtered = filtered.filter(a => a.pack === pack);
    if (search) filtered = filtered.filter(a =>
        a.name.toLowerCase().includes(search) ||
        a.pack.toLowerCase().includes(search) ||
        a.source.toLowerCase().includes(search)
    );

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const paged = filtered.slice(offset, offset + limit);

    res.json({
        assets: paged.map(a => ({
            name: a.name,
            category: a.category,
            source: a.source,
            pack: a.pack,
            fileUrl: `/assets/${a.filePath}`,
            thumbnailUrl: getThumbnailUrl(a.filePath),
            extension: a.extension,
            attribution: a.attribution || null,
        })),
        total, page, limit,
        totalPages: Math.ceil(total / limit),
    });
});

// List categories
router.get('/categories', (_req: Request, res: Response): void => {
    const counts: Record<string, number> = {};
    for (const a of assetCache) counts[a.category] = (counts[a.category] ?? 0) + 1;
    const categories = Object.entries(counts).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
    res.json({ categories });
});

// Browse directory structure
router.get('/browse', (req: Request, res: Response): void => {
    const category = (req.query.category as string) || '';
    const source = (req.query.source as string) || '';

    let filtered = assetCache;
    if (category) filtered = filtered.filter(a => a.category === category);

    if (source) {
        filtered = filtered.filter(a => a.source === source);
        const packCounts: Record<string, number> = {};
        for (const a of filtered) packCounts[a.pack] = (packCounts[a.pack] ?? 0) + 1;
        res.json({ packs: Object.entries(packCounts).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)) });
    } else {
        const sourceCounts: Record<string, number> = {};
        for (const a of filtered) sourceCounts[a.source] = (sourceCounts[a.source] ?? 0) + 1;
        res.json({ sources: Object.entries(sourceCounts).map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)) });
    }
});

// GLB animation metadata
router.get('/glb-animations', (req: Request, res: Response): void => {
    const assetPath = req.query.path as string;
    if (!assetPath) { res.status(400).json({ error: 'Missing path query parameter' }); return; }
    const fullPath = safePath(assetPath);
    if (!fullPath) { res.status(400).json({ error: 'Invalid path' }); return; }
    if (!fs.existsSync(fullPath)) { res.status(404).json({ error: 'File not found' }); return; }

    try {
        const buf = fs.readFileSync(fullPath);
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        if (view.getUint32(0, true) !== 0x46546C67) { res.json({ animations: [], hasSkeleton: false, jointCount: 0 }); return; }
        const jsonLen = view.getUint32(12, true);
        const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString('utf-8'));

        const animations = (gltf.animations || []).map((a: any) => {
            let name = a.name || 'unnamed';
            const pipeIdx = name.lastIndexOf('|');
            if (pipeIdx >= 0) name = name.substring(pipeIdx + 1);
            return { name };
        });

        const skin = gltf.skins?.[0];
        res.json({ animations, hasSkeleton: !!skin, jointCount: skin?.joints?.length || 0 });
    } catch {
        res.status(500).json({ error: 'Failed to parse GLB' });
    }
});

export default router;
