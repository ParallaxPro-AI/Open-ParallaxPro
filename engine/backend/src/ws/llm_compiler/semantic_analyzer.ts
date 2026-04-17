/**
 * Semantic Analyzer — validates AST nodes.
 */

import { ASTNode, EditNode, ToolCallNode } from './syntax_tree.js';
import { CompileError } from './errors.js';
import { analyzeSceneScriptAST } from './scene_script_analyzer.js';

export function analyze(ast: ASTNode[]): CompileError[] {
    const errors: CompileError[] = [];

    let listAssetsCount = 0;
    const validListAssetsArgs = new Set(['category', 'search', 'source', 'pack']);
    const validCategories = new Set(['3D Models', 'Characters', 'Animations', 'Audio', 'Textures']);

    for (const node of ast) {
        if (node.kind === 'edit') {
            analyzeEditBlock(node as EditNode, errors);
        } else if (node.kind === 'tool_call' && node.name === 'LOAD_TEMPLATE') {
            const validArgs = new Set(['template', 'query']);
            for (const key of Object.keys(node.args)) {
                if (!validArgs.has(key)) {
                    errors.push({
                        phase: 'semantic',
                        message: `LOAD_TEMPLATE: unknown argument "${key}"`,
                        hint: 'No args: random 20 templates. query="...": top matches by semantic search. template="name": builds the game.',
                    });
                }
            }
            // No args = random sample (valid). query = ranked search (valid). template = build (valid). All fine.
        } else if (node.kind === 'tool_call' && node.name === 'FIX_GAME') {
            const validArgs = new Set(['description']);
            for (const key of Object.keys(node.args)) {
                if (!validArgs.has(key)) {
                    errors.push({
                        phase: 'semantic',
                        message: `FIX_GAME: unknown argument "${key}"`,
                        hint: 'Usage: <<<FIX_GAME description="the enemies don\'t move">>><<<END>>>',
                    });
                }
            }
            if (!node.args.description) {
                errors.push({
                    phase: 'semantic',
                    message: 'FIX_GAME: missing required argument "description"',
                    hint: 'Describe the bug: <<<FIX_GAME description="...">>><<<END>>>',
                });
            }
        } else if (node.kind === 'tool_call' && node.name === 'CREATE_GAME') {
            if (!node.args.description) {
                errors.push({
                    phase: 'semantic',
                    message: 'CREATE_GAME: missing required argument "description"',
                    hint: 'Describe the game: <<<CREATE_GAME description="a tower defense game with...">>><<<END>>>',
                });
            }
        } else if (node.kind === 'tool_call' && node.name === 'LIST_ASSETS') {
            listAssetsCount++;
            if (listAssetsCount > 1) {
                errors.push({
                    phase: 'semantic',
                    message: 'Multiple LIST_ASSETS calls — only 1 per response',
                    hint: 'Call LIST_ASSETS once, then use the results.',
                });
            }
            for (const key of Object.keys(node.args)) {
                if (!validListAssetsArgs.has(key)) {
                    errors.push({
                        phase: 'semantic',
                        message: `LIST_ASSETS: unknown argument "${key}"`,
                        hint: `Valid arguments: category, search, source, pack. Example: <<<LIST_ASSETS category="3D Models" search="car">>><<<END>>>`,
                    });
                }
            }
            if (Object.keys(node.args).length === 0) {
                errors.push({
                    phase: 'semantic',
                    message: 'LIST_ASSETS: no arguments provided',
                    hint: 'Provide at least a category or search. Example: <<<LIST_ASSETS category="3D Models">>><<<END>>>',
                });
            }
            if (node.args.category && !validCategories.has(node.args.category)) {
                errors.push({
                    phase: 'semantic',
                    message: `LIST_ASSETS: invalid category "${node.args.category}"`,
                    hint: `Valid categories: ${[...validCategories].join(', ')}`,
                });
            }
            if (node.args.category && !node.args.search && !node.args.pack) {
                errors.push({
                    phase: 'semantic',
                    message: 'LIST_ASSETS: category alone returns too many results — add a search term',
                    hint: `Example: <<<LIST_ASSETS category="${node.args.category}" search="car">>><<<END>>>`,
                });
            }
        }
    }

    return errors;
}

function analyzeEditBlock(node: EditNode, errors: CompileError[]): void {
    const code = node.code;

    const forbidden = [
        { pattern: /\brequire\s*\(/, msg: 'require()' },
        { pattern: /\bimport\s*\(/, msg: 'dynamic import()' },
        { pattern: /\bprocess\b/, msg: 'process' },
        { pattern: /\b__dirname\b/, msg: '__dirname' },
        { pattern: /\b__filename\b/, msg: '__filename' },
        { pattern: /\bglobalThis\b/, msg: 'globalThis' },
        { pattern: /\beval\s*\(/, msg: 'eval()' },
        { pattern: /\bFunction\s*\(/, msg: 'Function()' },
    ];
    for (const f of forbidden) {
        if (f.pattern.test(code)) {
            errors.push({
                phase: 'semantic',
                message: `EDIT: forbidden use of ${f.msg}`,
                hint: 'EDIT blocks can only use the scene API and standard JS.',
            });
        }
    }

    const astErrors = analyzeSceneScriptAST(code);
    for (const e of astErrors) {
        errors.push({
            phase: 'semantic',
            message: `EDIT line ${e.line}: ${e.message}`,
            hint: e.hint,
        });
    }
}
