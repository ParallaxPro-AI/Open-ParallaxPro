/**
 * Executor — takes compiled AST and executes it.
 *
 * The raw AI text is THROWN AWAY after compilation.
 * Only the validated AST nodes are used for execution.
 */

import { ASTNode, MessageNode, EditNode, ToolCallNode } from './syntax_tree.js';
import { executeSceneScript } from './scene_script_executor.js';
import { EDIT_API_DOCS, getProjectSummary } from '../services/chat_protocol.js';

export interface ExecutionContext {
    sendToFrontend: (type: string, data: any) => void;
    getProjectData: () => any;
    saveProjectData: (data: any) => void;
    reloadScene: (sceneKey: string, sceneData: any) => void;
    searchAssets: (opts: { category?: string; search?: string; source?: string; pack?: string }) => { name: string; path: string; category: string; pack: string }[];
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

export function execute(ast: ASTNode[], ctx: ExecutionContext): ExecutionResult {
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
                executeToolCall(node as ToolCallNode, ctx, result);
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

function executeToolCall(node: ToolCallNode, ctx: ExecutionContext, result: ExecutionResult): void {
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
    }
}
