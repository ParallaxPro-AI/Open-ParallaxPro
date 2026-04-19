/**
 * Executor — takes compiled AST and executes it.
 *
 * The raw AI text is THROWN AWAY after compilation.
 * Only the validated AST nodes are used for execution.
 */

import { ASTNode, MessageNode, EditNode, ToolCallNode } from './syntax_tree.js';
import { config } from '../../config.js';
import { EDIT_API_DOCS, getProjectSummary } from '../services/chat_protocol.js';
import { loadTemplateCatalog, formatCatalogForLLM } from '../services/pipeline/template_loader.js';
import { runFixer } from '../services/pipeline/cli_fixer.js';
import { startGenerationJob } from '../services/pipeline/generation_jobs.js';
import { seedFromTemplate } from '../services/pipeline/project_seeder.js';
import type { BuildResult } from '../services/pipeline/project_builder.js';
import type { ProjectFiles } from '../services/pipeline/project_files.js';
import { runEditScript } from '../services/pipeline/template_mutator.js';

export interface ExecutionContext {
    sendToFrontend: (type: string, data: any) => void;
    /**
     * Returns the AI-facing project view: assembled scenes/scripts/uiFiles
     * (what the user sees in the editor) plus the underlying file tree and
     * source map for tools that need to mutate template sources.
     */
    getProjectData: () => any;
    /** Patch a set of files into the project's file tree, then rebuild and push. */
    commitFiles: (updates: Record<string, string | null>) => BuildResult | null;
    /** Replace the entire file tree (LOAD_TEMPLATE / CREATE_GAME), then rebuild and push. */
    replaceFiles: (newFiles: ProjectFiles, opts?: { name?: string }) => BuildResult | null;
    reloadScene: (sceneKey: string, sceneData: any) => void;
    searchAssets: (opts: { category?: string; search?: string; source?: string; pack?: string }) => Promise<{ name: string; path: string; category: string; pack: string }[]>;
    onFixerCost?: (costUsd: number) => void;
    abortSignal?: AbortSignal;
    projectId: string;
    /** Owner of the project; needed by CREATE_GAME to enforce the hosted
     *  per-user job cap and to attribute email notifications on
     *  completion. */
    userId: number;
    /** Cached on the executor so CREATE_GAME can stash them on the
     *  background job — they're how plugins attribute cost + emit
     *  admin events after the WS has disconnected. */
    username?: string;
    authToken?: string;
    activeSceneKey: string;
    /**
     * Which CLI fixer agent runs when FIX_GAME escalates. Passed through
     * from the incoming chat message so the frontend's localStorage pref
     * wins per call. Missing = "use the first installed CLI".
     */
    editingAgent?: string;
}

export interface ExecutionResult {
    userMessages: string[];
    errors: string[];
    madeChanges: boolean;
    fileChanges: { path: string; type: string }[];
    /** Tool call results to feed back to the AI for a follow-up response */
    toolResults: string | null;
}

export async function execute(ast: ASTNode[], ctx: ExecutionContext): Promise<ExecutionResult> {
    const result: ExecutionResult = {
        userMessages: [],
        errors: [],
        madeChanges: false,
        fileChanges: [],
        toolResults: null,
    };

    // If response has tool calls, skip EDIT blocks — tool results need to come back first
    const hasToolCalls = ast.some(n => n.kind === 'tool_call');

    for (const node of ast) {
        switch (node.kind) {
            case 'message':
                result.userMessages.push((node as MessageNode).text);
                break;

            case 'edit':
                if (!hasToolCalls) await executeEditNode(node as EditNode, ctx, result);
                break;

            case 'tool_call':
                await executeToolCall(node as ToolCallNode, ctx, result);
                break;
        }
    }

    return result;
}

async function executeEditNode(node: EditNode, ctx: ExecutionContext, result: ExecutionResult): Promise<void> {
    const view = ctx.getProjectData();
    const files = (view?.files || {}) as ProjectFiles;

    const session = runEditScript(ctx.projectId, files);
    const mut = await session.execute(node.code);

    if (!mut.success) {
        result.errors.push(mut.error ?? 'Unknown error');
        return;
    }

    if (Object.keys(mut.updatedFiles).length === 0) {
        // No template-file changes — surface warnings (e.g. unknown verbs) so the
        // AI can pivot to FIX_GAME if needed.
        if (mut.warnings.length > 0) {
            result.errors.push(`EDIT block did not modify the project. Warnings:\n${mut.warnings.join('\n')}`);
        }
        return;
    }

    const built = ctx.commitFiles(mut.updatedFiles);
    if (!built || !built.success) {
        result.errors.push(built?.error || 'Build failed after EDIT.');
        return;
    }

    result.madeChanges = true;
    for (const f of Object.keys(mut.updatedFiles)) {
        result.fileChanges.push({ path: f, type: 'modified' });
    }
}

async function executeToolCall(node: ToolCallNode, ctx: ExecutionContext, result: ExecutionResult): Promise<void> {
    switch (node.name) {
        case 'GET_EDIT_API': {
            const pd = ctx.getProjectData();
            const summary = getProjectSummary(pd, ctx.activeSceneKey);
            result.toolResults = `[GET_EDIT_API] Here is the EDIT API documentation and current project state:\n${EDIT_API_DOCS}\n${summary}\nNow use <<<EDIT>>>...<<<END>>> blocks to modify the scene.`;
            break;
        }

        case 'LIST_ASSETS': {
            const assets = await ctx.searchAssets({
                category: node.args.category,
                search: node.args.search,
                source: node.args.source,
                pack: node.args.pack,
            });

            if (assets.length === 0) {
                result.toolResults = '[LIST_ASSETS] No assets found matching your query.';
            } else {
                const lines = assets.map(a => `  ${a.name} → ${a.path}`);
                result.toolResults = `[LIST_ASSETS] Found ${assets.length} assets:\n${lines.join('\n')}`;
            }
            break;
        }

        case 'LOAD_TEMPLATE': {
            if (!node.args.template) {
                const catalog = loadTemplateCatalog();
                if (catalog.length === 0) {
                    result.toolResults = '[LOAD_TEMPLATE] No game templates found.';
                    break;
                }

                // query="..." → semantic ranking via shared template
                // embeddings. Falls back to random sample if the embedder
                // isn't ready so the tool never returns empty.
                const query = (node.args.query || '').trim();
                if (query) {
                    try {
                        const { rankTemplatesBySearch } = await import('../services/pipeline/template_index.js');
                        const ranked = await rankTemplatesBySearch(query);
                        const byId = new Map(catalog.map(t => [t.id, t]));
                        const TOP_N = 10;
                        const top = ranked.map(r => byId.get(r.id)).filter((t): t is any => !!t).slice(0, TOP_N);
                        if (top.length > 0) {
                            const topId = (top[0] as any).id;
                            result.toolResults = `[LOAD_TEMPLATE] Top ${top.length} templates for "${query}" (of ${catalog.length}):\n${formatCatalogForLLM(top)}\n\n────────────────────────────────────────\nYour NEXT OUTPUT must emit exactly one LOAD_TEMPLATE tag. Nothing else. No question, no preamble.\n\nExample (valid):\n    <<<LOAD_TEMPLATE template="${topId}">>><<<END>>>\n\nWriting "I've loaded the X template" in prose without the tag does NOT load anything — the user sees an empty project and thinks you lied.\n\nRules:\n• Pick the top match if it's even a rough fit — "minecraft"→voxel_survival, "racing"→any racing template, "shooter"→any fps. Loading is cheap and reversible.\n• Do NOT ask the user first. Do NOT write a { } explanation before loading. Just emit the tag.\n• The OFFER_CREATE_GAME fallback is almost never correct here. Only use it when the list is genuinely alien to the request (e.g. user asked for "chess" and the list is all racing games). For anything common like minecraft / fps / platformer / RPG / survival / racing — one of these templates is always close enough. If in doubt, LOAD.\n• If you do fall back: <<<OFFER_CREATE_GAME description="full game brief">>><<<END>>>. Never call CREATE_GAME directly.`;
                            break;
                        }
                    } catch {
                        // embedder not ready — fall through to random sample
                    }
                }

                // No query (or embedder unavailable): random sample so the
                // LLM gets breadth across calls without flooding context.
                const SAMPLE_SIZE = 20;
                const sample = catalog.length <= SAMPLE_SIZE
                    ? catalog
                    : [...catalog].sort(() => Math.random() - 0.5).slice(0, SAMPLE_SIZE);
                const sampleTopId = (sample[0] as any).id;
                result.toolResults = `[LOAD_TEMPLATE] Random sample of ${sample.length} of ${catalog.length} game templates:\n${formatCatalogForLLM(sample)}\n\n────────────────────────────────────────\nYour NEXT OUTPUT must emit exactly one tool tag. No question, no preamble, no "I'll load…" narration without the tag.\n\nBest path:\n1. If any entry above is a rough fit for the user's request, emit:\n       <<<LOAD_TEMPLATE template="${sampleTopId}">>><<<END>>>\n   (swap in the best-matching id from the list). Loading is cheap.\n2. If nothing above matches but the request is a real game type (e.g. user asked for "tower defense" and the random sample missed it), try a semantic query FIRST:\n       <<<LOAD_TEMPLATE query="tower defense">>><<<END>>>\n3. Only fall back to <<<OFFER_CREATE_GAME description="full game brief">>><<<END>>> after a semantic query also comes back irrelevant.\n\nWriting "I've loaded X" in prose without the tag does NOT load — the user sees an empty project. Emit the tag.`;
                break;
            }

            const seed = seedFromTemplate(node.args.template);
            if (!seed.templateId) {
                result.toolResults = `[LOAD_TEMPLATE] Template "${node.args.template}" not found. Call <<<LOAD_TEMPLATE>>><<<END>>> to see available templates.`;
                break;
            }

            const built = ctx.replaceFiles(seed.files);
            if (!built || !built.success) {
                result.toolResults = `[LOAD_TEMPLATE] Failed to build "${seed.templateId}": ${built?.error || 'unknown build error'}`;
                break;
            }

            result.madeChanges = true;
            result.fileChanges.push({ path: built.activeSceneKey, type: 'modified' });

            const entityCount = built.scenes[built.activeSceneKey]?.entities?.length ?? 0;
            const warnMsg = seed.warnings.length > 0 ? `\n(Warnings: ${seed.warnings.slice(0, 3).join('; ')})` : '';
            result.toolResults = `[LOAD_TEMPLATE] Successfully built "${seed.templateId}" with ${entityCount} entities. The game is now loaded in the editor.${warnMsg}\n\nIn your next message: (1) tell the user the game was loaded from the "${seed.templateId}" template, (2) in a { } block ask whether they'd prefer a fresh build from scratch (20–30 min, project locked, runs in the background), and (3) in the SAME response emit <<<OFFER_CREATE_GAME description="full game brief matching the user's request">>><<<END>>> so a "Create from scratch" button appears beside your message. Do NOT call CREATE_GAME yourself — clicking the button or a typed "yes" reply next turn will trigger it.`;
            break;
        }

        case 'FIX_GAME': {
            const description = node.args.description;
            if (!description) {
                result.toolResults = '[FIX_GAME] Missing description. Usage: <<<FIX_GAME description="the enemies don\'t move">>><<<END>>>';
                break;
            }

            const sendStatus = (msg: string) => ctx.sendToFrontend('fix_progress', { text: msg });
            sendStatus('Dispatching Editing Agent...');

            try {
                const view = ctx.getProjectData();
                const fixResult = await runFixer(
                    ctx.projectId,
                    description,
                    view.files as ProjectFiles,
                    ctx.activeSceneKey,
                    sendStatus,
                    ctx.abortSignal,
                    ctx.editingAgent,
                );

                if (fixResult.costUsd && ctx.onFixerCost) ctx.onFixerCost(fixResult.costUsd);

                // If the user hit Stop while the CLI was running, don't
                // commit partial changes to the project. The outer loop's
                // post-execute abort check will surface the "Generation
                // stopped" message to the user.
                if (ctx.abortSignal?.aborted) {
                    result.toolResults = '[FIX_GAME] Cancelled by user.';
                    break;
                }

                if (fixResult.success && fixResult.filesChanged.length > 0) {
                    const updates: Record<string, string | null> = {};
                    for (const [k, v] of Object.entries(fixResult.changedFiles)) updates[k] = v;
                    for (const k of fixResult.deletedFiles) updates[k] = null;
                    const built = ctx.commitFiles(updates);
                    if (!built || !built.success) {
                        // The commit helper already rolled the change back
                        // (no DB write happened) and re-pushed server
                        // truth. Tell the LLM in no uncertain terms so its
                        // follow-up turn doesn't claim success.
                        result.toolResults = `[FIX_GAME] ROLLED BACK — the agent's files didn't pass assembleGame validation: ${built?.error}. NO changes were applied to the project. In your next response, tell the user the fix attempt did not land, describe what you tried, and ask whether they want you to try again with a different approach. Do NOT claim success.`;
                        break;
                    }
                    result.madeChanges = true;
                    for (const f of fixResult.filesChanged) result.fileChanges.push({ path: f, type: 'modified' });
                    result.toolResults = `[FIX_GAME] ${fixResult.summary}. Tell the user the fix has been applied and they can press Play to test.`;
                } else if (fixResult.success) {
                    result.toolResults = `[FIX_GAME] ${fixResult.summary}`;
                } else {
                    result.toolResults = `[FIX_GAME] Fix failed: ${fixResult.summary}`;
                }
            } catch (e: any) {
                result.toolResults = `[FIX_GAME] Error: ${e.message}`;
            }
            break;
        }

        case 'OFFER_CREATE_GAME': {
            // Surface a "Create from scratch" button on the chat alongside
            // the AI's { } question. Intentionally NOT a confirmation —
            // clicking the button is what actually kicks off CREATE_GAME;
            // this tool just makes the button appear. No toolResults so
            // the AI's same-response text ends the chat turn (else we'd
            // preempt the user's answer with another AI turn).
            const description = node.args.description;
            if (!description) {
                // Silently drop — AI goofed. The { } text still renders,
                // user just won't see a button and can reply in text.
                break;
            }
            ctx.sendToFrontend('create_game_offer', { description });
            break;
        }

        case 'CREATE_GAME': {
            const description = node.args.description;
            if (!description) {
                result.toolResults = '[CREATE_GAME] Missing description — include the user\'s full game idea.';
                break;
            }

            // CREATE_GAME is fire-and-forget from the chat's point of view.
            // `startGenerationJob` writes the DB lock synchronously then
            // returns; the CLI runs in the background for ~20–30 min even
            // after the WebSocket closes. Completion is reported via the
            // generation_complete WS event (if a client is still watching)
            // and the hosted email plugin's onGenerationComplete hook.
            try {
                const jobId = await startGenerationJob({
                    projectId: ctx.projectId,
                    userId: ctx.userId,
                    username: ctx.username,
                    authToken: ctx.authToken,
                    description,
                    cliOverride: ctx.editingAgent,
                });
                // Tell the editor frontend to bounce to the project list —
                // the user will watch progress on the card, not in the
                // chat. editor_ws translates this into a WS event.
                ctx.sendToFrontend('generation_started', {
                    jobId,
                    projectId: ctx.projectId,
                    startedAt: new Date().toISOString(),
                    description,
                });
                // Tailor the "how you'll be notified" bit to the deploy
                // target — hosted deployments have the user's email and
                // will actually send a message; self-hosted ones don't,
                // so we tell the user to check back on the list.
                const notifyBit = config.isHosted
                    ? 'We\'ll send you an email the moment it\'s ready.'
                    : 'Just check back on the project list when you\'re ready — the card will update on its own.';
                result.toolResults =
                    `[CREATE_GAME] Background build started (job ${jobId.slice(0, 8)}). ` +
                    `Reply with a single warm, reassuring { } text block to the user — no tool call. It should say, in your own words: ` +
                    `"You can safely close your browser while we work on your custom game (takes ~20–30 minutes). ${notifyBit} ` +
                    `The project is locked for now — you can watch progress or stop the build from the project list." ` +
                    `Keep it to 1–2 short sentences, friendly and direct. Do NOT promise a preview, a Play button, or any specific generated content.`;
            } catch (e: any) {
                result.toolResults = `[CREATE_GAME] Could not start: ${e?.message || 'unknown error'}. Tell the user what went wrong — don't retry automatically.`;
            }
            break;
        }
    }
}
