/**
 * Executor — takes compiled AST and executes it.
 *
 * The raw AI text is THROWN AWAY after compilation.
 * Only the validated AST nodes are used for execution.
 */

import { ASTNode, MessageNode, EditNode, ToolCallNode } from './syntax_tree.js';
import { executeSceneScript } from './scene_script_executor.js';
import { EDIT_API_DOCS, getProjectSummary } from '../services/chat_protocol.js';
import { loadTemplateCatalog, loadTemplate, formatCatalogForLLM } from '../services/pipeline/template_loader.js';
import { assembleGame } from '../services/pipeline/level_assembler.js';
import { runFixer } from '../services/pipeline/cli_fixer.js';
import { runCreator } from '../services/pipeline/cli_creator.js';

export interface ExecutionContext {
    sendToFrontend: (type: string, data: any) => void;
    getProjectData: () => any;
    saveProjectData: (data: any) => void;
    reloadScene: (sceneKey: string, sceneData: any) => void;
    searchAssets: (opts: { category?: string; search?: string; source?: string; pack?: string }) => { name: string; path: string; category: string; pack: string }[];
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
    const pd = ctx.getProjectData() || {};
    if (!pd.scenes) pd.scenes = {};
    if (!pd.scenes[ctx.activeSceneKey]) {
        pd.scenes[ctx.activeSceneKey] = { name: ctx.activeSceneKey.replace('.json', ''), entities: [], environment: {} };
    }

    const scriptResult = executeSceneScript(node.code, pd.scenes, ctx.activeSceneKey);

    if (!scriptResult.success) {
        result.errors.push(scriptResult.error ?? 'Unknown error');
        return;
    }

    // Apply modified scenes back to project data
    pd.scenes = scriptResult.scenes;
    ctx.saveProjectData(pd);

    // Reload all modified scenes on the frontend
    for (const key of scriptResult.modifiedScenes) {
        ctx.reloadScene(key, pd.scenes[key]);
    }

    result.madeChanges = true;
    for (const key of scriptResult.modifiedScenes) {
        result.fileChanges.push({ path: key, type: 'modified' });
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
            const assets = ctx.searchAssets({
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
                // No template specified — list available templates
                const catalog = loadTemplateCatalog();
                if (catalog.length === 0) {
                    result.toolResults = '[LOAD_TEMPLATE] No game templates found.';
                } else {
                    result.toolResults = `[LOAD_TEMPLATE] Available game templates:\n${formatCatalogForLLM(catalog)}\n\nIf one matches, call: <<<LOAD_TEMPLATE template="template_id">>><<<END>>>\nIf NONE match, apologize and tell the user that game type is not available yet. Show them the list so they can pick one.`;
                }
            } else {
                // Template specified — build the game
                const template = loadTemplate(node.args.template);
                if (!template || !template._folderPath) {
                    result.toolResults = `[LOAD_TEMPLATE] Template "${node.args.template}" not found. Call <<<LOAD_TEMPLATE>>><<<END>>> to see available templates.`;
                    break;
                }

                try {
                    const assembled = assembleGame(template._folderPath);

                    // Update project data with the assembled game
                    const pd = ctx.getProjectData();
                    const sceneKey = ctx.activeSceneKey;
                    pd.scenes = pd.scenes || {};
                    pd.scenes[sceneKey] = {
                        name: template.name,
                        entities: assembled.entities,
                        environment: {
                            ambientColor: [1, 1, 1],
                            ambientIntensity: 0.3,
                            fog: { enabled: false, color: [0.8, 0.8, 0.8], near: 10, far: 100 },
                            gravity: [0, -9.81, 0],
                            timeOfDay: 12,
                            dayNightCycleSpeed: 0,
                        },
                    };

                    // Merge scripts and UI files
                    pd.scripts = { ...(pd.scripts || {}), ...assembled.scripts };
                    pd.uiFiles = { ...(pd.uiFiles || {}), ...assembled.uiFiles };

                    ctx.saveProjectData(pd);
                    // Send full project reload (scene + scripts + UI) for game builds
                    ctx.sendToFrontend('project_reload', {
                        sceneKey,
                        sceneData: pd.scenes[sceneKey],
                        scripts: pd.scripts,
                        uiFiles: pd.uiFiles,
                    });

                    result.madeChanges = true;
                    result.fileChanges.push({ path: sceneKey, type: 'modified' });

                    const entityCount = assembled.entities.length;
                    const scriptCount = Object.keys(assembled.scripts).length;
                    result.toolResults = `[LOAD_TEMPLATE] Successfully built "${template.name}" with ${entityCount} entities. The game is now loaded in the editor.\n\nTell the user: the game was generated from the "${template.name}" template. Ask if they want you to incorporate any customizations, or if they'd prefer to start from an empty template and build from scratch.`;
                } catch (e: any) {
                    result.toolResults = `[LOAD_TEMPLATE] Failed to build "${node.args.template}": ${e.message}`;
                }
            }
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
                const pd = ctx.getProjectData();
                const fixResult = await runFixer(ctx.projectId, description, pd, ctx.activeSceneKey, sendStatus, ctx.abortSignal);

                // Report fixer cost for usage tracking
                if (fixResult.costUsd && ctx.onFixerCost) {
                    ctx.onFixerCost(fixResult.costUsd);
                }

                if (fixResult.success && fixResult.filesChanged.length > 0) {
                    ctx.saveProjectData(pd);

                    // Reload frontend with updated data
                    const sceneKey = ctx.activeSceneKey;
                    if (pd.scenes?.[sceneKey]) {
                        ctx.sendToFrontend('project_reload', {
                            sceneKey,
                            sceneData: pd.scenes[sceneKey],
                            scripts: pd.scripts,
                            uiFiles: pd.uiFiles,
                        });
                    }

                    result.madeChanges = true;
                    for (const f of fixResult.filesChanged) {
                        result.fileChanges.push({ path: f, type: 'modified' });
                    }
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

                if (createResult.success && createResult.assembled) {
                    const pd = ctx.getProjectData();
                    const sceneKey = ctx.activeSceneKey;
                    pd.scenes = pd.scenes || {};
                    pd.scenes[sceneKey] = {
                        name: createResult.templateId,
                        entities: createResult.assembled.entities,
                        environment: {
                            ambientColor: [1, 1, 1],
                            ambientIntensity: 0.3,
                            fog: { enabled: false, color: [0.8, 0.8, 0.8], near: 10, far: 100 },
                            gravity: [0, -9.81, 0],
                            timeOfDay: 12,
                            dayNightCycleSpeed: 0,
                        },
                    };
                    pd.scripts = { ...(pd.scripts || {}), ...createResult.assembled.scripts };
                    pd.uiFiles = { ...(pd.uiFiles || {}), ...createResult.assembled.uiFiles };

                    ctx.saveProjectData(pd);
                    ctx.sendToFrontend('project_reload', {
                        sceneKey,
                        sceneData: pd.scenes[sceneKey],
                        scripts: pd.scripts,
                        uiFiles: pd.uiFiles,
                    });

                    result.madeChanges = true;
                    result.fileChanges.push({ path: sceneKey, type: 'modified' });
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
