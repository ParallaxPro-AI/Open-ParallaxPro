import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';

const THUMB_SIZE = 256;
const GLB_BATCH_SIZE = 20;
const IMAGE_BATCH_SIZE = 20;

const BLENDER_SCRIPT = `
import bpy
import mathutils
import sys
import os
import math

argv = sys.argv
sep = argv.index("--") + 1
pairs = []
i = sep
while i < len(argv) - 1:
    pairs.append((argv[i], argv[i+1]))
    i += 2

for glb_path, out_path in pairs:
    try:
        bpy.ops.wm.read_factory_settings(use_empty=True)
        bpy.ops.import_scene.gltf(filepath=glb_path)

        for obj in bpy.context.scene.objects:
            if obj.type == 'ARMATURE':
                obj.data.pose_position = 'REST'
            if obj.type == 'MESH':
                for mod in list(obj.modifiers):
                    if mod.type == 'ARMATURE':
                        obj.modifiers.remove(mod)
                if len(obj.data.materials) == 0:
                    obj.hide_render = True
        bpy.context.view_layer.update()

        min_co = [float('inf')] * 3
        max_co = [float('-inf')] * 3
        has_mesh = False
        for obj in bpy.context.scene.objects:
            if obj.type == 'MESH' and not obj.hide_render:
                has_mesh = True
                bbox = [obj.matrix_world @ mathutils.Vector(c) for c in obj.bound_box]
                for v in bbox:
                    for j in range(3):
                        min_co[j] = min(min_co[j], v[j])
                        max_co[j] = max(max_co[j], v[j])

        if not has_mesh:
            continue

        cx = (min_co[0] + max_co[0]) / 2
        cy = (min_co[1] + max_co[1]) / 2
        cz = (min_co[2] + max_co[2]) / 2
        size = max(max_co[0] - min_co[0], max_co[1] - min_co[1], max_co[2] - min_co[2], 0.01)
        height = max_co[2] - min_co[2]
        center = mathutils.Vector((cx, cy, min_co[2] + height * 0.4))
        dist = size * 1.8

        cam_data = bpy.data.cameras.new('ThumbCam')
        cam_data.type = 'PERSP'
        cam_data.lens = 50
        cam_obj = bpy.data.objects.new('ThumbCam', cam_data)
        bpy.context.scene.collection.objects.link(cam_obj)
        bpy.context.scene.camera = cam_obj
        cam_obj.location = (center.x + dist * 0.7, center.y - dist * 0.9, center.z + dist * 0.5)
        direction = center - cam_obj.location
        cam_obj.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

        for name, energy, rot in [('Key', 4, (50, 10, -30)), ('Fill', 2, (60, -20, 150)), ('Rim', 1.5, (30, 0, 90))]:
            ld = bpy.data.lights.new(name, 'SUN')
            ld.energy = energy
            lo = bpy.data.objects.new(name, ld)
            lo.rotation_euler = tuple(math.radians(r) for r in rot)
            bpy.context.scene.collection.objects.link(lo)

        bpy.context.scene.render.film_transparent = True
        bpy.context.scene.render.resolution_x = ${THUMB_SIZE}
        bpy.context.scene.render.resolution_y = ${THUMB_SIZE}
        bpy.context.scene.render.resolution_percentage = 100
        bpy.context.scene.render.image_settings.file_format = 'PNG'
        bpy.context.scene.render.image_settings.color_mode = 'RGBA'
        bpy.context.scene.render.engine = 'CYCLES'
        bpy.context.scene.cycles.device = 'CPU'
        bpy.context.scene.cycles.samples = 32

        os.makedirs(os.path.dirname(out_path), exist_ok=True)
        bpy.context.scene.render.filepath = out_path
        bpy.ops.render.render(write_still=True)
    except Exception as e:
        print(f"THUMB_ERROR: {glb_path}: {e}")
`;

function findExecutable(name: string): string | null {
    const common = [
        `/opt/homebrew/bin/${name}`,
        `/usr/local/bin/${name}`,
        `/usr/bin/${name}`,
    ];
    for (const p of common) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function walkFiles(dir: string, ext: RegExp, skip?: (name: string) => boolean): string[] {
    const results: string[] = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory() && entry.name !== 'thumbnails' && entry.name !== 'generated' && entry.name !== 'previews') {
            results.push(...walkFiles(full, ext, skip));
        } else if (entry.isFile() && ext.test(entry.name)) {
            if (skip && skip(entry.name)) continue;
            results.push(full);
        }
    }
    return results;
}

function runBlenderBatch(blenderPath: string, pairs: [string, string][]): Promise<void> {
    return new Promise((resolve) => {
        const scriptPath = path.join('/tmp', 'parallax_thumb_render.py');
        fs.writeFileSync(scriptPath, BLENDER_SCRIPT);

        const args = ['--background', '--python', scriptPath, '--'];
        for (const [glb, out] of pairs) args.push(glb, out);

        execFile(blenderPath, args, { timeout: 300000 }, (err) => {
            if (err) console.error(`[Thumbnails] Blender error:`, err.message?.split('\n')[0]);
            resolve();
        });
    });
}

function resizeImage(magickPath: string, src: string, dst: string): Promise<void> {
    return new Promise((resolve) => {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        execFile(magickPath, [src, '-resize', `${THUMB_SIZE}x${THUMB_SIZE}>`, dst], { timeout: 30000 }, (err) => {
            if (err) console.error(`[Thumbnails] ImageMagick error for ${path.basename(src)}:`, err.message?.split('\n')[0]);
            resolve();
        });
    });
}

export async function generateThumbnails(assetsDir: string): Promise<void> {
    const thumbnailsDir = path.join(assetsDir, 'thumbnails');
    fs.mkdirSync(thumbnailsDir, { recursive: true });

    // GLB thumbnails via Blender
    const blender = findExecutable('blender');
    if (blender) {
        const glbFiles = walkFiles(assetsDir, /\.glb$/i);
        const pending: [string, string][] = [];
        for (const glbPath of glbFiles) {
            const relPath = path.relative(assetsDir, glbPath);
            const thumbPath = path.join(thumbnailsDir, relPath.replace(/\.glb$/i, '.png'));
            if (!fs.existsSync(thumbPath)) pending.push([glbPath, thumbPath]);
        }

        if (pending.length === 0) {
            console.log(`[Thumbnails] ${glbFiles.length} GLBs — all cached`);
        } else {
            console.log(`[Thumbnails] Generating ${pending.length} GLB thumbnails (${glbFiles.length - pending.length} cached)...`);
            for (let i = 0; i < pending.length; i += GLB_BATCH_SIZE) {
                await runBlenderBatch(blender, pending.slice(i, i + GLB_BATCH_SIZE));
                const done = Math.min(i + GLB_BATCH_SIZE, pending.length);
                if (done % 200 === 0 || done === pending.length) console.log(`[Thumbnails] GLB progress: ${done}/${pending.length}`);
            }
        }
    } else {
        console.log('[Thumbnails] Blender not found, skipping GLB thumbnails');
    }

    // Texture thumbnails via ImageMagick
    const magick = findExecutable('magick');
    if (magick) {
        const skipNonDiffuse = (name: string) =>
            /(_nor|_normal|_nrm|_rough|_roughness|_ao|_ambient|_disp|_displacement|_height|_metal|_metallic|_spec|_specular|_opacity|_arm|_bump)[\._]/i.test(name);

        const imageFiles = walkFiles(assetsDir, /\.(png|jpg|jpeg)$/i, skipNonDiffuse);
        const pending: [string, string][] = [];
        for (const imgPath of imageFiles) {
            const relPath = path.relative(assetsDir, imgPath);
            const thumbPath = path.join(thumbnailsDir, relPath);
            if (!fs.existsSync(thumbPath)) pending.push([imgPath, thumbPath]);
        }

        if (pending.length === 0) {
            console.log(`[Thumbnails] ${imageFiles.length} textures — all cached`);
        } else {
            console.log(`[Thumbnails] Generating ${pending.length} texture thumbnails (${imageFiles.length - pending.length} cached)...`);
            for (let i = 0; i < pending.length; i += IMAGE_BATCH_SIZE) {
                await Promise.all(pending.slice(i, i + IMAGE_BATCH_SIZE).map(([s, d]) => resizeImage(magick, s, d)));
                const done = Math.min(i + IMAGE_BATCH_SIZE, pending.length);
                if (done % 500 === 0 || done === pending.length) console.log(`[Thumbnails] Texture progress: ${done}/${pending.length}`);
            }
        }
    } else {
        console.log('[Thumbnails] ImageMagick not found, skipping texture thumbnails');
    }
}
