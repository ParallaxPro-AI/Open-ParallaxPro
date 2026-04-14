/**
 * Executor — takes compiled AST and executes it.
 *
 * The raw AI text is THROWN AWAY after compilation.
 * Only the validated AST nodes are used for execution.
 */

import { ASTNode, MessageNode, EditNode, ToolCallNode } from './syntax_tree.js';
import { EDIT_API_DOCS, getProjectSummary } from '../services/chat_protocol.js';
import { loadTemplateCatalog, formatCatalogForLLM } from '../services/pipeline/template_loader.js';
import { runFixer } from '../services/pipeline/cli_fixer.js';
import { runCreator } from '../services/pipeline/cli_creator.js';
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
    activeSceneKey: string;
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
                if (!hasToolCalls) executeEditNode(node as EditNode, ctx, result);
                break;

            case 'tool_call':
                await executeToolCall(node as ToolCallNode, ctx, result);
                break;
        }
    }

    return result;
}

function executeEditNode(node: EditNode, ctx: ExecutionContext, result: ExecutionResult): void {
    const view = ctx.getProjectData();
    const files = (view?.files || {}) as ProjectFiles;

    const session = runEditScript(ctx.projectId, files);
    const mut = session.execute(node.code);

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
                } else {
                    result.toolResults = `[LOAD_TEMPLATE] Available game templates:\n${formatCatalogForLLM(catalog)}\n\nIf one matches, call: <<<LOAD_TEMPLATE template="template_id">>><<<END>>>\nIf NONE match, apologize and tell the user that game type is not available yet. Show them the list so they can pick one.`;
                }
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
            result.toolResults = `[LOAD_TEMPLATE] Successfully built "${seed.templateId}" with ${entityCount} entities. The game is now loaded in the editor.${warnMsg}\n\nTell the user: the game was generated from the "${seed.templateId}" template. Ask if they want you to incorporate any customizations, or if they'd prefer to start from an empty template and build from scratch.`;
            break;
        }

        case 'FIX_GAME': {
            const description = node.args.description;
            if (!description) {
                result.toolResults = '[FIX_GAME] Missing description. Usage: <<<FIX_GAME description="the enemies don\'t move">>><<<END>>>';
                break;
            }

            const sendStatus = (msg: string) => ctx.sendToFrontend('fix_progress', { text: msg });
            sendStatus('Fixing game...');

            try {
                const view = ctx.getProjectData();
                const editingAgent = view?.projectConfig?.editingAgent;
                const fixResult = await runFixer(
                    ctx.projectId,
                    description,
                    view.files as ProjectFiles,
                    ctx.activeSceneKey,
                    sendStatus,
                    ctx.abortSignal,
                    editingAgent,
                );

                if (fixResult.costUsd && ctx.onFixerCost) ctx.onFixerCost(fixResult.costUsd);

                if (fixResult.success && fixResult.filesChanged.length > 0) {
                    const updates: Record<string, string | null> = {};
                    for (const [k, v] of Object.entries(fixResult.changedFiles)) updates[k] = v;
                    for (const k of fixResult.deletedFiles) updates[k] = null;
                    const built = ctx.commitFiles(updates);
                    if (!built || !built.success) {
                        result.toolResults = `[FIX_GAME] Fix produced files but the build failed: ${built?.error}`;
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

        case 'CREATE_GAME': {
            const description = node.args.description;
            if (!description) {
                result.toolResults = '[CREATE_GAME] Missing description.';
                break;
            }

            const sendStatus = (msg: string) => ctx.sendToFrontend('fix_progress', { text: msg });
            sendStatus('Creating game from scratch...');

            try {
                const createResult = await runCreator(ctx.projectId, description, sendStatus);

                if (createResult.success && createResult.files) {
                    const built = ctx.replaceFiles(createResult.files);
                    if (!built || !built.success) {
                        result.toolResults = `[CREATE_GAME] Created files but the build failed: ${built?.error}\n\nDo NOT retry CREATE_GAME. Tell the user that creating this game from scratch was not possible right now, and suggest using an existing template instead.`;
                        break;
                    }
                    result.madeChanges = true;
                    result.fileChanges.push({ path: built.activeSceneKey, type: 'modified' });
                    result.toolResults = `[CREATE_GAME] ${createResult.summary}. The game "${createResult.templateId}" has been created and loaded. Tell the user to press Play to try it.`;
                } else {
                    result.toolResults = `[CREATE_GAME] Failed: ${createResult.summary}\n\nDo NOT retry CREATE_GAME. Tell the user that creating this game from scratch was not possible right now, and suggest using an existing template instead.`;
                }
            } catch (e: any) {
                result.toolResults = `[CREATE_GAME] Error: ${e.message}`;
            }
            break;
        }
    }
}
