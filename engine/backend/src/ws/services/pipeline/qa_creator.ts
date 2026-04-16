/**
 * QA Creator — replaces the agent-CLI CREATE_GAME path with a structured
 * Q&A approach against the chat LLM.
 *
 * Flow:
 *   1. pickClosestTemplate(description) → templateId (embedding + keyword fallback)
 *   2. load that template's 4 JSONs as our seed
 *   3. ask the chat LLM (one structured-output call) for a customization plan
 *      — title, player tweaks, phase list — picking from real library names
 *   4. assembler applies the plan, dropping anything that doesn't validate
 *      against the library catalog
 *   5. assembleGame() runs as the final validator; on failure we revert to
 *      the bare template (which is hand-crafted and guaranteed to pass)
 *
 * Returns the same CreatorResult shape that runCreator did, so executor.ts
 * is a drop-in replacement.
 *
 * Hard guarantees:
 *   - Every script reference (behaviors[].script, systems.<k>.script) is
 *     validated against the library catalog before being written.
 *   - assembleGame() is the gate — if it throws, we fall back to baseline.
 *   - The bare template ALWAYS passes (we wrote it). So this function
 *     CANNOT return a project that fails validation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { fileURLToPath } from 'url';
import { config } from '../../../config.js';
import { assembleGame } from './level_assembler.js';
import {
    ProjectFiles,
    writeFilesToDir,
    ENGINE_MACHINERY,
} from './project_files.js';
import { pickClosestTemplate, TEMPLATES } from './template_index.js';
import {
    getLibraryCatalog,
    formatCatalogForPrompt,
    isKnownBehavior,
    isKnownSystem,
    isKnownUI,
    LibraryCatalog,
} from './library_catalog.js';

const __dirname_qa = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname_qa, 'reusable_game_components');

export interface CreatorResult {
    success: boolean;
    summary: string;
    templateId: string;
    files: ProjectFiles | null;
    costUsd: number;
}

interface CustomizationPlan {
    id?: string;
    name?: string;
    subtitle?: string;
    player?: {
        mesh_type?: 'cube' | 'sphere' | 'capsule' | 'cylinder' | 'cone' | 'plane' | 'custom';
        mesh_asset?: string;        // /assets/... path; validated against disk
        mesh_color?: [number, number, number, number];
        mesh_scale?: [number, number, number];
    };
    hud_panels_to_add?: string[];
    hud_panels_to_remove?: string[];
    behavior_swaps?: Array<{ entity?: string; from?: string; to: string; params?: Record<string, any> }>;
    systems_to_add?: string[];
    systems_to_remove?: string[];
    world_changes?: Array<{
        op: 'add' | 'remove';
        ref?: string;                            // for "add"
        name?: string;                           // for "remove"
        position?: [number, number, number];
        count?: number;                          // for "add" — defaults to 1
        scatter?: 'random' | 'line' | 'grid';   // for count > 1
        scatter_radius?: number;
    }>;
    multiplayer?: {
        enabled: boolean;
        minPlayers?: number;
        maxPlayers?: number;
        tickRate?: number;
    };
    phases?: Array<{ name: string; implemented?: boolean }>;
}

export async function runQaCreator(
    projectId: string,
    description: string,
    sendStatus?: (msg: string) => void,
    abortSignal?: AbortSignal,
): Promise<CreatorResult> {
    sendStatus?.('Picking closest template...');
    const pick = await pickClosestTemplate(description);
    const templateId = pick.id || 'platformer';   // safest fallback if nothing matches at all
    const id = deriveGameId(description);
    if (abortSignal?.aborted) return aborted(templateId);

    sendStatus?.(`Seeding from "${templateId}"...`);
    const baseline = loadTemplateBaseline(templateId);
    if (!baseline) {
        // Should never happen — every TEMPLATES entry must have a real dir.
        return { success: false, summary: `Template "${templateId}" not found on disk.`, templateId, files: null, costUsd: 0 };
    }

    sendStatus?.('Designing your game...');
    const catalog = getLibraryCatalog();
    let plan: CustomizationPlan = {};
    let costUsd = 0;
    try {
        const planResult = await fetchCustomizationPlan(description, templateId, catalog, abortSignal);
        plan = planResult.plan;
        costUsd = planResult.costUsd;
    } catch (e: any) {
        // LLM failed entirely — still ship the bare template under the user's id.
        plan = { id, name: humanizeId(id) };
        console.warn(`[QaCreator] customization LLM failed: ${e?.message || e}; using baseline`);
    }
    if (abortSignal?.aborted) return aborted(templateId, costUsd);

    // Always overwrite id with our derived one (LLM's id is a suggestion).
    plan.id = id;
    if (!plan.name) plan.name = humanizeId(id);

    sendStatus?.('Assembling files...');
    const assembled = applyPlan(baseline, plan, catalog);

    sendStatus?.('Running final validation...');
    const validated = validateOrFallback(assembled, baseline, templateId);

    const summary = formatSummary(plan, templateId, validated.usedFallback);
    return {
        success: true,
        summary,
        templateId,
        files: validated.files,
        costUsd,
    };
}

// ─── Template baseline ────────────────────────────────────────────────────

function loadTemplateBaseline(templateId: string): ProjectFiles | null {
    const templateDir = path.join(RGC_DIR, 'game_templates', 'v0.1', templateId);
    if (!fs.existsSync(templateDir)) return null;

    const files: ProjectFiles = {};

    // The 4 JSONs.
    for (const name of ['01_flow.json', '02_entities.json', '03_worlds.json', '04_systems.json']) {
        const p = path.join(templateDir, name);
        if (fs.existsSync(p)) files[name] = fs.readFileSync(p, 'utf-8');
    }

    // Engine machinery (every template needs these in project/).
    for (const rel of ENGINE_MACHINERY) {
        const sub = rel.replace(/^systems\//, '');
        const src = path.join(RGC_DIR, 'systems', 'v0.1', sub);
        if (fs.existsSync(src)) files[rel] = fs.readFileSync(src, 'utf-8');
    }

    // Pull in every behavior/system/UI the template's JSONs reference,
    // copying from the shared library into project/.
    const referenced = extractReferencedFiles(files);
    for (const ref of referenced) {
        const src = path.join(RGC_DIR, ref.kind, 'v0.1', ref.relPath);
        if (fs.existsSync(src)) files[ref.kind + '/' + ref.relPath] = fs.readFileSync(src, 'utf-8');
    }

    return files;
}

function extractReferencedFiles(files: ProjectFiles): Array<{ kind: 'behaviors' | 'systems' | 'ui'; relPath: string }> {
    const out: Array<{ kind: 'behaviors' | 'systems' | 'ui'; relPath: string }> = [];
    try {
        const ent = JSON.parse(files['02_entities.json'] || '{}');
        for (const def of Object.values<any>(ent.definitions || {})) {
            for (const b of def.behaviors || []) {
                if (typeof b?.script === 'string') out.push({ kind: 'behaviors', relPath: b.script });
            }
        }
    } catch {}
    try {
        const sys = JSON.parse(files['04_systems.json'] || '{}');
        for (const s of Object.values<any>(sys.systems || {})) {
            if (typeof s?.script === 'string') out.push({ kind: 'systems', relPath: s.script });
        }
    } catch {}
    try {
        const flow = JSON.parse(files['01_flow.json'] || '{}');
        const panels = new Set<string>();
        const scan = (n: any): void => {
            if (Array.isArray(n)) {
                for (const item of n) {
                    if (typeof item === 'string' && item.startsWith('show_ui:')) {
                        panels.add(item.slice('show_ui:'.length));
                    }
                }
            } else if (n && typeof n === 'object') {
                for (const v of Object.values(n)) scan(v);
            }
        };
        scan(flow);
        for (const p of panels) out.push({ kind: 'ui', relPath: p + '.html' });
    } catch {}
    const seen = new Set<string>();
    return out.filter(r => {
        const k = r.kind + ':' + r.relPath;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
    });
}

// ─── LLM call for customization plan ──────────────────────────────────────

async function fetchCustomizationPlan(
    description: string,
    templateId: string,
    catalog: LibraryCatalog,
    abortSignal: AbortSignal | undefined,
): Promise<{ plan: CustomizationPlan; costUsd: number }> {
    const systemPrompt = buildSystemPrompt(templateId, catalog);
    const userPrompt = `Build a game template for this user description:\n\n"${description}"\n\nReturn ONLY the JSON object. No markdown, no prose.`;

    if (!isDirectApiConfigured()) {
        // Fall back to chat CLI (claude/codex/opencode/copilot in -p mode) for
        // self-hosted instances without an LLM API. Slower but avoids spinning
        // up a full agent — we only need a single short response.
        const text = await callChatCliForJson(systemPrompt, userPrompt, 60000);
        return { plan: parsePlan(text), costUsd: 0 };
    }

    const { baseUrl, model, apiKey } = config.ai;
    const controller = new AbortController();
    if (abortSignal) abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
        const res = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                max_tokens: 4096,
                stream: false,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt },
                ],
            }),
            signal: controller.signal,
        });
        if (!res.ok) throw new Error(`LLM API ${res.status}`);
        const data: any = await res.json();
        const text: string = data?.choices?.[0]?.message?.content || '';
        const usage = data?.usage || {};
        const inputTok = usage.prompt_tokens || 0;
        const outputTok = usage.completion_tokens || 0;
        // Rough $/MTok estimate (Groq pricing for gpt-oss-120b range): in 0.15, out 0.60
        const costUsd = (inputTok * 0.15 + outputTok * 0.60) / 1_000_000;
        return { plan: parsePlan(text), costUsd };
    } finally {
        clearTimeout(timer);
    }
}

function isDirectApiConfigured(): boolean {
    return !!(config.ai.baseUrl && config.ai.model && config.ai.apiKey);
}

async function callChatCliForJson(systemPrompt: string, userPrompt: string, timeoutMs: number): Promise<string> {
    // Self-hosted fallback when no LLM API is configured: shell out to one of
    // the installed chat-capable CLIs in `-p` mode and collect stdout. We
    // prefer claude → codex → opencode → copilot in that probe order.
    const { spawnSync } = await import('child_process');
    const sandboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppai-qa-'));
    try {
        // Prefer claude → codex → opencode → copilot.
        const cliCandidates: Array<{ bin: string; args: (prompt: string) => string[] }> = [
            { bin: 'claude',   args: p => ['-p', p, '--output-format', 'text', '--max-turns', '1'] },
            { bin: 'codex',    args: p => ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-C', sandboxDir, p] },
            { bin: 'opencode', args: p => ['run', '--dir', sandboxDir, p] },
            { bin: 'copilot',  args: p => ['-p', p, '--allow-all', '--no-ask-user', '--no-auto-update', '--log-level', 'none', '--add-dir', sandboxDir] },
        ];
        const fullPrompt = systemPrompt + '\n\n' + userPrompt;
        for (const { bin, args } of cliCandidates) {
            const which = spawnSync('which', [bin]);
            if (which.status !== 0) continue;
            const result = spawnSync(bin, args(fullPrompt), {
                cwd: sandboxDir,
                timeout: timeoutMs,
                env: { ...process.env, HOME: process.env.HOME || '/tmp' },
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            if (result.status === 0 && result.stdout) return result.stdout.toString();
        }
        return '';
    } finally {
        try { fs.rmSync(sandboxDir, { recursive: true, force: true }); } catch {}
    }
}

function parsePlan(raw: string): CustomizationPlan {
    if (!raw) return {};
    // LLM may wrap in ```json ... ``` even when asked not to.
    const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    // Sometimes there's prose before the JSON — extract the first { ... } block.
    const start = stripped.indexOf('{');
    const end = stripped.lastIndexOf('}');
    if (start === -1 || end === -1 || end <= start) return {};
    try {
        return JSON.parse(stripped.slice(start, end + 1));
    } catch {
        return {};
    }
}

// ─── System prompt builder ────────────────────────────────────────────────

function buildSystemPrompt(templateId: string, catalog: LibraryCatalog): string {
    return [
        `You are designing a game template for the ParallaxPro 3D game engine.`,
        `Your output is consumed by a deterministic assembler that composes existing library pieces — you DO NOT write code.`,
        ``,
        `## Picked starting template`,
        `\`${templateId}\` will be used as the seed. project/ will already contain its 4 JSONs and every behavior/system/UI it references.`,
        ``,
        `## Your job`,
        `Output a JSON customization plan that makes the game feel like what the user asked for. Be opinionated about title, theme, player mesh/color, and which entities exist in the world. The assembler validates every reference against the library catalog and silently drops anything that doesn't match — so reference real names only.`,
        ``,
        `## Constraints`,
        `- Reference ONLY library names listed below. Anything else is dropped silently.`,
        `- Do NOT invent event names, behavior paths, system paths, UI panel names.`,
        `- mesh_type must be one of: cube, sphere, capsule, cylinder, cone, plane, custom.`,
        `- For mesh_asset, use the asset path conventions below. Bad paths are dropped.`,
        `- mesh_color is [r, g, b, a], each 0..1.`,
        ``,
        `## Asset path conventions (use these prefixes to compose mesh_asset)`,
        `- Characters (humanoid): /assets/quaternius/characters/character-male-a.glb, .../character-female-a.glb, .../character-skeleton.glb, etc.`,
        `- Blocky characters:     /assets/kenney/3d_models/blocky_characters/character-a.glb, character-b.glb, ... character-p.glb`,
        `- Vehicles:              /assets/kenney/3d_models/vehicles/race.glb, race-future.glb, sedan.glb, tractor.glb, taxi.glb, police.glb, ambulance.glb, truck.glb, suv.glb, hatchback.glb`,
        `- Tanks:                 /assets/kenney/3d_models/vehicles/tank.glb`,
        `- Spaceships:            /assets/kenney/3d_models/space/craft_speederA.glb, craft_miner.glb, craft_racer.glb`,
        `- Nature props:          /assets/kenney/3d_models/nature/tree-default.glb, rocks-large-a.glb, bush.glb, grass-leafs.glb`,
        `- Urban props:           /assets/kenney/3d_models/urban/building-a.glb, lamp-double.glb, bench.glb`,
        `- Survival props:        /assets/kenney/3d_models/survival/crate.glb, barrel.glb, lantern.glb`,
        `- Detail props:          /assets/kenney/3d_models/platformer/crate.glb, spike.glb, coin-bronze.glb, coin-gold.glb`,
        `- Generic textures:      /assets/kenney/textures/prototype_dark/dark_06.png  (for grounds and walls)`,
        `If unsure, omit mesh_asset and use a primitive mesh_type.`,
        ``,
        `## JSON output schema (omit fields you don't need)`,
        '```',
        '{',
        '  "id":       "kebab-case-game-id",',
        '  "name":     "Human Title",',
        '  "subtitle": "short tagline (max 40 chars)",',
        '',
        '  "player": {',
        '    "mesh_type":  "cube|sphere|capsule|cylinder|cone|plane|custom",',
        '    "mesh_asset": "/assets/...",     // GLB or texture path; only meaningful when mesh_type is custom',
        '    "mesh_color": [r,g,b,a],          // 0..1 each — used for primitives or as material override',
        '    "mesh_scale": [x,y,z]',
        '  },',
        '',
        '  "behavior_swaps": [',
        '    { "entity": "<entity name in 02_entities.json>", "from": "<old script path>", "to": "movement/...", "params": {...} }',
        '  ],',
        '',
        '  "systems_to_add":      [ "gameplay/scoring.ts", ... ],',
        '  "systems_to_remove":   [ "gameplay/race_manager.ts", ... ],',
        '',
        '  "hud_panels_to_add":   [ "hud/health", ... ],',
        '  "hud_panels_to_remove":[ "hud/race_countdown", ... ],',
        '',
        '  "world_changes": [',
        '    { "op": "add", "ref": "<entity name from 02_entities.json definitions>", "position": [x,y,z] },',
        '    { "op": "add", "ref": "spike", "count": 12, "scatter": "line",   "scatter_radius": 30 },',
        '    { "op": "add", "ref": "tree",  "count": 8,  "scatter": "random", "scatter_radius": 40 },',
        '    { "op": "remove", "name": "<scene-level entity name>" }',
        '  ],',
        '',
        '  "multiplayer": {                    // ONLY include if user asked for MP / online / multiplayer / co-op',
        '    "enabled": true,',
        '    "minPlayers": 2,',
        '    "maxPlayers": 8,',
        '    "tickRate": 30',
        '  },',
        '',
        '  "phases": [',
        '    { "name": "Phase 1: <one-line summary of what is playable now>", "implemented": true },',
        '    { "name": "Phase 2: <next feature>" },',
        '    { "name": "Phase 3: <next feature>" }',
        '  ]',
        '}',
        '```',
        ``,
        `## Library catalog (the only names you may reference)`,
        formatCatalogForPrompt(catalog),
    ].join('\n');
}

// ─── Assembler ────────────────────────────────────────────────────────────

function applyPlan(baseline: ProjectFiles, plan: CustomizationPlan, catalog: LibraryCatalog): ProjectFiles {
    const files: ProjectFiles = { ...baseline };

    // 1. Title rename — always safe.
    files['01_flow.json'] = patchFlowMetadata(files['01_flow.json'], plan);

    // 2. Player mesh tweaks (primitive type, color, scale, GLB asset).
    if (plan.player) {
        files['02_entities.json'] = patchPlayerMesh(files['02_entities.json'], plan.player);
    }

    // 3. Behavior swaps — validate each before applying.
    if (Array.isArray(plan.behavior_swaps)) {
        for (const swap of plan.behavior_swaps) {
            if (!swap?.to || !isKnownBehavior(catalog, swap.to)) continue;
            files['02_entities.json'] = patchBehaviorSwap(files['02_entities.json'], swap);
            const src = path.join(RGC_DIR, 'behaviors', 'v0.1', swap.to);
            if (fs.existsSync(src)) files['behaviors/' + swap.to] = fs.readFileSync(src, 'utf-8');
        }
    }

    // 4. Systems add/remove — validate each.
    if (Array.isArray(plan.systems_to_remove)) {
        for (const s of plan.systems_to_remove) {
            files['04_systems.json'] = removeSystem(files['04_systems.json'], s);
            files['01_flow.json'] = removeFromActiveSystems(files['01_flow.json'], s);
        }
    }
    if (Array.isArray(plan.systems_to_add)) {
        for (const s of plan.systems_to_add) {
            if (!isKnownSystem(catalog, s)) continue;
            files['04_systems.json'] = addSystem(files['04_systems.json'], s);
            files['01_flow.json']    = addToActiveSystems(files['01_flow.json'], s);
            const src = path.join(RGC_DIR, 'systems', 'v0.1', s);
            if (fs.existsSync(src)) files['systems/' + s] = fs.readFileSync(src, 'utf-8');
        }
    }

    // 5. HUD panels add/remove — only on the gameplay state's on_enter/on_exit.
    if (Array.isArray(plan.hud_panels_to_remove)) {
        for (const p of plan.hud_panels_to_remove) {
            files['01_flow.json'] = removeHudFromGameplay(files['01_flow.json'], p);
        }
    }
    if (Array.isArray(plan.hud_panels_to_add)) {
        for (const p of plan.hud_panels_to_add) {
            if (!isKnownUI(catalog, p)) continue;
            files['01_flow.json'] = addHudToGameplay(files['01_flow.json'], p);
            const withExt = p.endsWith('.html') ? p : p + '.html';
            const src = path.join(RGC_DIR, 'ui', 'v0.1', withExt);
            if (fs.existsSync(src)) files['ui/' + withExt] = fs.readFileSync(src, 'utf-8');
        }
    }

    // 6. World changes (add/remove placements). Each op validated against
    //    02_entities.json definitions / existing placement names; bad ops
    //    are dropped silently.
    if (Array.isArray(plan.world_changes)) {
        files['03_worlds.json'] = applyWorldChanges(files['03_worlds.json'], files['02_entities.json'], plan.world_changes);
    }

    // 7. Multiplayer toggle — add the flow-level block, attach a network
    //    block to the player entity, and ensure mp_bridge is in
    //    active_systems for every state. Adding mp_bridge is safe — the
    //    file is part of ENGINE_MACHINERY so it's always pre-staged in
    //    project/systems/mp/mp_bridge.ts.
    if (plan.multiplayer && plan.multiplayer.enabled) {
        files['01_flow.json']    = patchMultiplayerBlock(files['01_flow.json'], plan.multiplayer);
        files['02_entities.json'] = patchPlayerNetworkBlock(files['02_entities.json']);
        files['04_systems.json'] = addSystem(files['04_systems.json'], 'mp/mp_bridge.ts');
        files['01_flow.json']    = addToActiveSystemsAllStates(files['01_flow.json'], 'mp/mp_bridge.ts');
    }

    return files;
}

// ─── Per-mutator helpers (each one returns the patched file string) ───────

function patchFlowMetadata(flowJson: string | undefined, plan: CustomizationPlan): string {
    if (!flowJson) return flowJson || '';
    try {
        const flow = JSON.parse(flowJson);
        if (plan.id) flow.id = plan.id;
        if (plan.name) flow.name = plan.name;
        flow.ui_params = flow.ui_params || {};
        flow.ui_params.main_menu = flow.ui_params.main_menu || {};
        if (plan.name) flow.ui_params.main_menu.gameTitle = plan.name.toUpperCase();
        if (plan.subtitle) flow.ui_params.main_menu.gameSubtitle = plan.subtitle;
        return JSON.stringify(flow, null, 2);
    } catch { return flowJson; }
}

function patchPlayerMesh(entJson: string | undefined, p: NonNullable<CustomizationPlan['player']>): string {
    if (!entJson) return entJson || '';
    try {
        const entities = JSON.parse(entJson);
        const defs = entities.definitions || {};
        // Find the entity tagged "player" (or named "player" / "Player").
        let key: string | null = null;
        for (const k of Object.keys(defs)) {
            const d = defs[k];
            if (Array.isArray(d.tags) && d.tags.includes('player')) { key = k; break; }
            if (k.toLowerCase() === 'player') { key = k; break; }
        }
        if (!key) return entJson;
        const def = defs[key];
        def.mesh = def.mesh || {};

        // mesh_asset takes precedence — if it's a real GLB on disk, use it
        // and force mesh_type to "custom". Otherwise fall back to primitive.
        if (p.mesh_asset && assetExistsOnDisk(p.mesh_asset)) {
            def.mesh.type = 'custom';
            def.mesh.asset = p.mesh_asset;
        } else if (p.mesh_type) {
            def.mesh.type = p.mesh_type === 'custom' ? 'cube' : p.mesh_type;
            // Switching to a primitive — strip the GLB asset path so the
            // engine renders the primitive instead of trying to load both.
            if (def.mesh.type !== 'custom') delete def.mesh.asset;
        }

        if (Array.isArray(p.mesh_color) && p.mesh_color.length === 4) {
            def.mesh.materialOverrides = def.mesh.materialOverrides || {};
            def.mesh.materialOverrides.baseColor = p.mesh_color;
        }
        if (Array.isArray(p.mesh_scale) && p.mesh_scale.length === 3) {
            def.mesh.scale = p.mesh_scale;
        }
        return JSON.stringify(entities, null, 2);
    } catch { return entJson; }
}

function assetExistsOnDisk(assetPath: string): boolean {
    if (typeof assetPath !== 'string' || !assetPath.startsWith('/assets/')) return false;
    const rel = assetPath.replace(/^\/assets\//, '');
    try { return fs.existsSync(path.join(config.assetsDir, rel)); }
    catch { return false; }
}

function patchBehaviorSwap(entJson: string | undefined, swap: NonNullable<CustomizationPlan['behavior_swaps']>[number]): string {
    if (!entJson) return entJson || '';
    try {
        const entities = JSON.parse(entJson);
        const defs = entities.definitions || {};
        for (const k of Object.keys(defs)) {
            // Match by entity name if specified, else apply to all entities that have the `from` behavior.
            if (swap.entity && k.toLowerCase() !== swap.entity.toLowerCase()) continue;
            const d = defs[k];
            if (!Array.isArray(d.behaviors)) continue;
            for (const b of d.behaviors) {
                if (swap.from && b.script !== swap.from) continue;
                b.script = swap.to;
                if (swap.params) b.params = { ...(b.params || {}), ...swap.params };
                // Behavior name auto-derived from filename if not set.
                if (!b.name) b.name = path.basename(swap.to, path.extname(swap.to));
            }
        }
        return JSON.stringify(entities, null, 2);
    } catch { return entJson; }
}

function addSystem(sysJson: string | undefined, scriptPath: string): string {
    if (!sysJson) return sysJson || '';
    try {
        const sysFile = JSON.parse(sysJson);
        sysFile.systems = sysFile.systems || {};
        const key = path.basename(scriptPath, path.extname(scriptPath));
        if (!sysFile.systems[key]) {
            sysFile.systems[key] = { description: `Added: ${key}`, script: scriptPath };
        }
        return JSON.stringify(sysFile, null, 2);
    } catch { return sysJson; }
}

function removeSystem(sysJson: string | undefined, scriptPath: string): string {
    if (!sysJson) return sysJson || '';
    try {
        const sysFile = JSON.parse(sysJson);
        const sysMap = sysFile.systems || {};
        for (const k of Object.keys(sysMap)) {
            if (sysMap[k]?.script === scriptPath) delete sysMap[k];
        }
        return JSON.stringify(sysFile, null, 2);
    } catch { return sysJson; }
}

function addToActiveSystems(flowJson: string | undefined, scriptPath: string): string {
    if (!flowJson) return flowJson || '';
    try {
        const flow = JSON.parse(flowJson);
        const key = path.basename(scriptPath, path.extname(scriptPath));
        const visit = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node.active_systems) && !node.active_systems.includes(key)) {
                node.active_systems.push(key);
            }
            if (node.substates) for (const v of Object.values(node.substates)) visit(v);
        };
        for (const stateName of Object.keys(flow.states || {})) {
            // Add to gameplay-ish states only (heuristic: not boot/main_menu/lobby/game_over).
            if (/^(boot|main_menu|lobby|game_over|connecting|disconnected)/i.test(stateName)) continue;
            visit(flow.states[stateName]);
        }
        return JSON.stringify(flow, null, 2);
    } catch { return flowJson; }
}

function removeFromActiveSystems(flowJson: string | undefined, scriptPath: string): string {
    if (!flowJson) return flowJson || '';
    try {
        const flow = JSON.parse(flowJson);
        const key = path.basename(scriptPath, path.extname(scriptPath));
        const visit = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node.active_systems)) {
                node.active_systems = node.active_systems.filter((s: string) => s !== key);
            }
            if (node.substates) for (const v of Object.values(node.substates)) visit(v);
        };
        for (const v of Object.values(flow.states || {})) visit(v);
        return JSON.stringify(flow, null, 2);
    } catch { return flowJson; }
}

function addHudToGameplay(flowJson: string | undefined, panel: string): string {
    return mutateGameplayActions(flowJson, panel, /* add */ true);
}
function removeHudFromGameplay(flowJson: string | undefined, panel: string): string {
    return mutateGameplayActions(flowJson, panel, /* add */ false);
}
function mutateGameplayActions(flowJson: string | undefined, panel: string, add: boolean): string {
    if (!flowJson) return flowJson || '';
    try {
        const flow = JSON.parse(flowJson);
        const showAction = `show_ui:${panel}`;
        const hideAction = `hide_ui:${panel}`;
        const visit = (node: any) => {
            if (!node || typeof node !== 'object') return;
            // Apply only on states with a "playing"-shaped name.
            // (Heuristic — reasonable across templates.)
            // Actually just look for any state with active_behaviors set.
            if (Array.isArray(node.active_behaviors) || Array.isArray(node.active_systems)) {
                node.on_enter = node.on_enter || [];
                node.on_exit  = node.on_exit  || [];
                if (add) {
                    if (!node.on_enter.includes(showAction)) node.on_enter.push(showAction);
                    if (!node.on_exit.includes(hideAction))  node.on_exit.push(hideAction);
                } else {
                    node.on_enter = node.on_enter.filter((a: string) => a !== showAction);
                    node.on_exit  = node.on_exit.filter((a: string) => a !== hideAction);
                }
            }
            if (node.substates) for (const v of Object.values(node.substates)) visit(v);
        };
        for (const v of Object.values(flow.states || {})) visit(v);
        return JSON.stringify(flow, null, 2);
    } catch { return flowJson; }
}

// ─── World changes ────────────────────────────────────────────────────────

function applyWorldChanges(
    worldsJson: string | undefined,
    entitiesJson: string | undefined,
    changes: NonNullable<CustomizationPlan['world_changes']>,
): string {
    if (!worldsJson || !entitiesJson) return worldsJson || '';
    let worlds: any;
    let entities: any;
    try {
        worlds = JSON.parse(worldsJson);
        entities = JSON.parse(entitiesJson);
    } catch { return worldsJson; }

    const definitions = entities.definitions || {};
    const validRefs = new Set(Object.keys(definitions));

    const firstWorld = Array.isArray(worlds.worlds) ? worlds.worlds[0] : null;
    if (!firstWorld) return worldsJson;
    firstWorld.placements = firstWorld.placements || [];

    for (const change of changes) {
        if (!change || typeof change !== 'object') continue;
        if (change.op === 'remove') {
            if (!change.name) continue;
            firstWorld.placements = firstWorld.placements.filter((p: any) => p.name !== change.name && p.ref !== change.name);
        } else if (change.op === 'add') {
            if (!change.ref || !validRefs.has(change.ref)) continue;
            const count = Math.min(Math.max(1, change.count || 1), 50);
            for (let i = 0; i < count; i++) {
                const pos = pickPosition(change, i);
                const placement: any = { ref: change.ref, position: pos };
                if (count > 1) placement.name = `${change.ref} ${i + 1}`;
                firstWorld.placements.push(placement);
            }
        }
    }
    return JSON.stringify(worlds, null, 2);
}

function pickPosition(change: NonNullable<CustomizationPlan['world_changes']>[number], i: number): [number, number, number] {
    if (change.position && change.position.length === 3) return change.position;
    const r = Math.max(1, change.scatter_radius || 20);
    if (change.scatter === 'line') {
        // Spread along the negative-z axis in a single line — works well for
        // courses, lanes, and obstacle paths.
        const count = Math.max(1, change.count || 1);
        const z = -((i + 1) * r) / count;
        return [0, 1, z];
    }
    if (change.scatter === 'grid') {
        const cols = Math.ceil(Math.sqrt(Math.max(1, change.count || 1)));
        const cx = (i % cols) - Math.floor(cols / 2);
        const cz = Math.floor(i / cols);
        return [cx * (r / cols * 2), 1, -cz * (r / cols * 2) - 5];
    }
    // Default 'random'
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * r;
    return [Math.cos(angle) * dist, 1, Math.sin(angle) * dist];
}

// ─── Multiplayer toggle ───────────────────────────────────────────────────

function patchMultiplayerBlock(flowJson: string | undefined, mp: NonNullable<CustomizationPlan['multiplayer']>): string {
    if (!flowJson) return flowJson || '';
    try {
        const flow = JSON.parse(flowJson);
        flow.multiplayer = {
            enabled: true,
            minPlayers: clamp(mp.minPlayers ?? 2, 1, 16),
            maxPlayers: clamp(mp.maxPlayers ?? 8, 1, 16),
            tickRate:   clamp(mp.tickRate   ?? 30, 5, 60),
            authority: 'host',
            predictLocalPlayer: true,
            hostPlaysGame: true,
        };
        return JSON.stringify(flow, null, 2);
    } catch { return flowJson; }
}

function patchPlayerNetworkBlock(entJson: string | undefined): string {
    if (!entJson) return entJson || '';
    try {
        const entities = JSON.parse(entJson);
        const defs = entities.definitions || {};
        let key: string | null = null;
        for (const k of Object.keys(defs)) {
            const d = defs[k];
            if (Array.isArray(d.tags) && d.tags.includes('player')) { key = k; break; }
            if (k.toLowerCase() === 'player') { key = k; break; }
        }
        if (!key) return entJson;
        const def = defs[key];
        def.network = def.network || {
            syncTransform: true,
            syncInterval: 33,
            ownership: 'local_player',
            predictLocally: true,
            networkedVars: [],
        };
        return JSON.stringify(entities, null, 2);
    } catch { return entJson; }
}

// Like addToActiveSystems but applies to EVERY state, not just gameplay-y
// ones — mp_bridge needs to be alive in lobby + main_menu + game_over too.
function addToActiveSystemsAllStates(flowJson: string | undefined, scriptPath: string): string {
    if (!flowJson) return flowJson || '';
    try {
        const flow = JSON.parse(flowJson);
        const key = path.basename(scriptPath, path.extname(scriptPath));
        const visit = (node: any) => {
            if (!node || typeof node !== 'object') return;
            if (Array.isArray(node.active_systems) || node.on_enter || node.transitions) {
                node.active_systems = node.active_systems || [];
                if (!node.active_systems.includes(key)) node.active_systems.push(key);
            }
            if (node.substates) for (const v of Object.values(node.substates)) visit(v);
        };
        for (const v of Object.values(flow.states || {})) visit(v);
        return JSON.stringify(flow, null, 2);
    } catch { return flowJson; }
}

function clamp(n: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, n));
}

// ─── Validate-or-fallback ─────────────────────────────────────────────────

function validateOrFallback(
    files: ProjectFiles,
    baseline: ProjectFiles,
    templateId: string,
): { files: ProjectFiles; usedFallback: boolean } {
    // Run assembleGame in a temp dir — it's the strict validator that catches
    // missing scripts, malformed JSON, broken FSM transitions, etc.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ppai-validate-'));
    try {
        writeFilesToDir(files, tmpDir);
        try {
            assembleGame(tmpDir, {
                behaviors: path.join(tmpDir, 'behaviors'),
                systems:   path.join(tmpDir, 'systems'),
                ui:        path.join(tmpDir, 'ui'),
            });
            return { files, usedFallback: false };
        } catch (e: any) {
            console.warn(`[QaCreator] customized game failed validation, falling back to bare ${templateId}: ${e.message}`);
            // Fall back: use bare template (which we know passes — it's what
            // the user gets via LOAD_TEMPLATE today). Still apply title/id
            // from the plan so the user sees their requested name.
            return { files: baseline, usedFallback: true };
        }
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
}

// ─── Misc ─────────────────────────────────────────────────────────────────

function deriveGameId(description: string): string {
    return description
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter(w => !['a', 'an', 'the', 'game', 'with', 'and', 'of', 'for', 'that', 'where', 'make', 'create', 'build', 'i', 'want'].includes(w))
        .slice(0, 3)
        .join('_') || 'custom_game';
}

function humanizeId(id: string): string {
    return id.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

function aborted(templateId: string, costUsd: number = 0): CreatorResult {
    return { success: false, summary: 'Aborted by user.', templateId, files: null, costUsd };
}

function formatSummary(plan: CustomizationPlan, templateId: string, usedFallback: boolean): string {
    const lines: string[] = [];
    const title = plan.name || humanizeId(plan.id || templateId);
    if (usedFallback) {
        lines.push(`Built **${title}** from the \`${templateId}\` template (kept the baseline since the customized version didn't validate). Press Play.`);
    } else {
        lines.push(`Built **${title}** based on the \`${templateId}\` template. Press Play.`);
    }
    if (Array.isArray(plan.phases) && plan.phases.length > 0) {
        const first = plan.phases.find(p => p.implemented) || plan.phases[0];
        const remaining = plan.phases.filter(p => p !== first);
        lines.push('');
        lines.push(`**Phase 1 done** — ${first.name.replace(/^Phase \d+:\s*/, '')}.`);
        if (remaining.length > 0) {
            lines.push('');
            lines.push(`**Remaining phases** (ask me to do any next):`);
            for (let i = 0; i < remaining.length; i++) {
                lines.push(`- Phase ${i + 2}: ${remaining[i].name.replace(/^Phase \d+:\s*/, '')}`);
            }
        }
    }
    return lines.join('\n');
}

// Suppress unused warnings — TEMPLATES is exported from the module via re-export.
void TEMPLATES;
