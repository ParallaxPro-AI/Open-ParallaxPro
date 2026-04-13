/**
 * osm_texture_cache.ts — Loads and caches PBR textures for OSM world materials.
 *
 * Buildings use a WebGPU texture_2d_array with 14 wall textures from Poly Haven,
 * allowing all buildings in a chunk to draw in a single call while each picks
 * its own material via a per-vertex layer index.
 */

// ── Building texture array ───────────────────────────────────────────

export interface BuildingTextureEntry {
	/** Directory name under poly_haven/textures/ */
	dir: string;
	/** How many meters one UV tile covers */
	uvMetersPerTile: number;
	metallic: number;
	roughness: number;
	/** Material category for shader color palette: 0=residential, 1=commercial, 2=brick, 3=industrial, 4=concrete */
	category: number;
}

/**
 * 14 Poly Haven wall textures forming the building texture array.
 * The array index is stored per-vertex in buildingMeta bits [0:3].
 */
export const BUILDING_TEXTURES: BuildingTextureEntry[] = [
	// Residential (layers 0-3)
	{ dir: 'plastered_wall', uvMetersPerTile: 4, metallic: 0.0, roughness: 0.85, category: 0 },
	{ dir: 'painted_plaster_wall', uvMetersPerTile: 4, metallic: 0.0, roughness: 0.80, category: 0 },
	{ dir: 'blue_plaster_weathered', uvMetersPerTile: 4, metallic: 0.0, roughness: 0.88, category: 0 },
	{ dir: 'grey_plaster_02', uvMetersPerTile: 4, metallic: 0.0, roughness: 0.82, category: 0 },
	// Commercial (layers 4-6)
	{ dir: 'concrete_tile_facade', uvMetersPerTile: 6, metallic: 0.3, roughness: 0.40, category: 1 },
	{ dir: 'concrete_panels', uvMetersPerTile: 5, metallic: 0.2, roughness: 0.45, category: 1 },
	{ dir: 'concrete_wall_004', uvMetersPerTile: 5, metallic: 0.1, roughness: 0.50, category: 1 },
	// Brick (layers 7-9)
	{ dir: 'brick_wall_02', uvMetersPerTile: 3, metallic: 0.0, roughness: 0.90, category: 2 },
	{ dir: 'brick_wall_07', uvMetersPerTile: 3, metallic: 0.0, roughness: 0.88, category: 2 },
	{ dir: 'painted_brick', uvMetersPerTile: 3, metallic: 0.0, roughness: 0.85, category: 2 },
	// Concrete (layers 10-11)
	{ dir: 'beige_wall_001', uvMetersPerTile: 5, metallic: 0.0, roughness: 0.85, category: 4 },
	{ dir: 'concrete_slab_wall', uvMetersPerTile: 5, metallic: 0.0, roughness: 0.80, category: 4 },
	// Industrial (layers 12-13)
	{ dir: 'corrugated_iron', uvMetersPerTile: 3, metallic: 0.5, roughness: 0.45, category: 3 },
	{ dir: 'corrugated_iron_02', uvMetersPerTile: 3, metallic: 0.5, roughness: 0.50, category: 3 },
];

/** Layer index ranges for classifyBuilding() to pick from */
export const BUILDING_LAYER_RANGES: Record<string, [number, number]> = {
	residential: [0, 3], // layers 0-3
	commercial: [4, 6], // layers 4-6
	brick: [7, 9], // layers 7-9
	concrete: [10, 11], // layers 10-11
	industrial: [12, 13], // layers 12-13
};

// ── Loaders ──────────────────────────────────────────────────────────

async function loadImageBitmap(url: string): Promise<ImageBitmap> {
	const resp = await fetch(url);
	const blob = await resp.blob();
	return createImageBitmap(blob);
}

/**
 * Load all building textures into a 2D-array GPUTexture.
 * Returns the array textures and per-layer PBR properties.
 */
export async function loadBuildingTextureArrays(
	device: any, // GPUDevice
	assetBaseUrl: string = '/assets/',
): Promise<{
	diffuseArray: any; // GPUTexture (texture_2d_array)
	normalArray: any; // GPUTexture (texture_2d_array)
	layerProps: Float32Array; // [uvScale, metallic, roughness, category] × 14
} | null> {
	const count = BUILDING_TEXTURES.length;

	// Load all bitmaps in parallel (diffuse + normal)
	const diffBitmaps: (ImageBitmap | null)[] = new Array(count).fill(null);
	const normBitmaps: (ImageBitmap | null)[] = new Array(count).fill(null);

	await Promise.all(
		BUILDING_TEXTURES.flatMap((entry, i) => {
			const diffUrl = `${assetBaseUrl}poly_haven/textures/${entry.dir}/${entry.dir}_diff_1k.jpg`;
			const normUrl = `${assetBaseUrl}poly_haven/textures/${entry.dir}/${entry.dir}_nor_gl_1k.jpg`;
			return [
				loadImageBitmap(diffUrl)
					.then((bmp) => {
						diffBitmaps[i] = bmp;
					})
					.catch(() => {
						console.warn(`[BuildingTextures] Failed to load diffuse: ${entry.dir}`);
					}),
				loadImageBitmap(normUrl)
					.then((bmp) => {
						normBitmaps[i] = bmp;
					})
					.catch(() => {
						console.warn(`[BuildingTextures] Failed to load normal: ${entry.dir}`);
					}),
			];
		}),
	);

	// Create 2D-array textures — mipLevelCount=1 avoids uninitialized mips
	// being sampled as alpha=0 (WebGPU zero-inits unpopulated levels).
	const size = [1024, 1024, count] as const;

	const diffuseArray = device.createTexture({
		label: 'building_diffuse_array',
		size,
		mipLevelCount: 1,
		format: 'rgba8unorm',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
	});

	const normalArray = device.createTexture({
		label: 'building_normal_array',
		size,
		mipLevelCount: 1,
		format: 'rgba8unorm',
		usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
	});

	// Copy each layer
	for (let i = 0; i < count; i++) {
		if (diffBitmaps[i]) {
			device.queue.copyExternalImageToTexture(
				{ source: diffBitmaps[i]! },
				{ texture: diffuseArray, origin: { x: 0, y: 0, z: i } },
				[1024, 1024],
			);
		}
		if (normBitmaps[i]) {
			device.queue.copyExternalImageToTexture(
				{ source: normBitmaps[i]! },
				{ texture: normalArray, origin: { x: 0, y: 0, z: i } },
				[1024, 1024],
			);
		}
	}

	// Clean up bitmaps
	for (const bmp of diffBitmaps) bmp?.close();
	for (const bmp of normBitmaps) bmp?.close();

	// Pack per-layer properties: [uvScale, metallic, roughness, category]
	const layerProps = new Float32Array(count * 4);
	for (let i = 0; i < count; i++) {
		const t = BUILDING_TEXTURES[i];
		layerProps[i * 4 + 0] = 1.0 / t.uvMetersPerTile;
		layerProps[i * 4 + 1] = t.metallic;
		layerProps[i * 4 + 2] = t.roughness;
		layerProps[i * 4 + 3] = t.category;
	}

	return { diffuseArray, normalArray, layerProps };
}
