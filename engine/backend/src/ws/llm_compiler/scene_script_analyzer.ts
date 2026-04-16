/**
 * EDIT Block Static Analyzer — AST-based type checking for scene API calls.
 *
 * Parses JavaScript into an AST (via acorn), walks the tree, and validates
 * every `scene.*` call against the API schema.
 */

import * as acorn from 'acorn';
import {
    VALID_ENTITY_TYPES, VALID_COMPONENT_TYPES,
    VALID_COLLIDER_SHAPES, VALID_BODY_TYPES,
} from './schemas.js';

export interface SceneScriptError {
    line: number;
    message: string;
    hint: string;
}

type ArgType = 'string' | 'number' | 'object' | 'any' | 'boolean';

interface MethodSchema {
    args: { name: string; type: ArgType; optional?: boolean }[];
    validate?: (args: acorn.Node[], errors: SceneScriptError[], line: number) => void;
}

const SCENE_API: Record<string, MethodSchema> = {
    // Entities
    addEntity: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'type', type: 'string' },
            { name: 'options', type: 'object', optional: true },
        ],
        validate: (args, errors, line) => {
            const typeArg = args[1];
            if (typeArg?.type === 'Literal' && typeof (typeArg as any).value === 'string') {
                const val = (typeArg as any).value;
                if (!VALID_ENTITY_TYPES.has(val)) {
                    errors.push({ line, message: `addEntity: invalid type "${val}"`, hint: `Valid: ${[...VALID_ENTITY_TYPES].join(', ')}` });
                }
            }
            if (args[2]?.type === 'ObjectExpression') {
                validateEntityOptions(args[2] as any, errors, line);
            }
        },
    },
    deleteEntity: { args: [{ name: 'name', type: 'string' }] },
    duplicateEntity: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'newName', type: 'string', optional: true },
        ],
    },
    renameEntity: {
        args: [
            { name: 'oldName', type: 'string' },
            { name: 'newName', type: 'string' },
        ],
    },
    setActive: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'active', type: 'boolean' },
        ],
    },
    setParent: {
        args: [
            { name: 'childName', type: 'string' },
            { name: 'parentName', type: 'any' },
        ],
    },

    // Transform
    setPosition: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'x', type: 'number' },
            { name: 'y', type: 'number' },
            { name: 'z', type: 'number' },
        ],
    },
    translate: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'dx', type: 'number' },
            { name: 'dy', type: 'number' },
            { name: 'dz', type: 'number' },
        ],
    },
    scaleBy: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'sx', type: 'number' },
            { name: 'sy', type: 'number' },
            { name: 'sz', type: 'number' },
        ],
    },
    rotate: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'dx', type: 'number' },
            { name: 'dy', type: 'number' },
            { name: 'dz', type: 'number' },
        ],
    },
    setScale: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'x', type: 'number' },
            { name: 'y', type: 'number' },
            { name: 'z', type: 'number' },
        ],
    },
    setRotation: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'x', type: 'number' },
            { name: 'y', type: 'number' },
            { name: 'z', type: 'number' },
        ],
    },

    // Components
    addComponent: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'componentType', type: 'string' },
            { name: 'data', type: 'object', optional: true },
        ],
        validate: (args, errors, line) => {
            const typeArg = args[1];
            if (typeArg?.type === 'Literal' && typeof (typeArg as any).value === 'string') {
                const val = (typeArg as any).value;
                if (!VALID_COMPONENT_TYPES.has(val)) {
                    errors.push({ line, message: `addComponent: invalid type "${val}"`, hint: `Valid: ${[...VALID_COMPONENT_TYPES].join(', ')}` });
                }
            }
        },
    },
    removeComponent: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'componentType', type: 'string' },
        ],
    },

    // Materials & Tags
    setMaterial: {
        args: [
            { name: 'name', type: 'string' },
            { name: 'materialOverrides', type: 'object' },
        ],
    },
    addTag: { args: [{ name: 'name', type: 'string' }, { name: 'tag', type: 'string' }] },
    removeTag: { args: [{ name: 'name', type: 'string' }, { name: 'tag', type: 'string' }] },

    // Query
    findEntity: { args: [{ name: 'name', type: 'string' }] },
    getEntities: { args: [] },
    getEntityCount: { args: [] },

    // Environment
    setGravity: {
        args: [
            { name: 'x', type: 'number' },
            { name: 'y', type: 'number' },
            { name: 'z', type: 'number' },
        ],
    },
    setAmbientLight: {
        args: [
            { name: 'color', type: 'any' },
            { name: 'intensity', type: 'number' },
        ],
    },
    setEnvironment: { args: [{ name: 'props', type: 'object' }] },
    setFog: {
        args: [
            { name: 'enabled', type: 'boolean' },
            { name: 'color', type: 'any', optional: true },
            { name: 'near', type: 'number', optional: true },
            { name: 'far', type: 'number', optional: true },
        ],
    },
    setTimeOfDay: { args: [{ name: 'hour', type: 'number' }] },

    // Multi-scene
    switchScene: { args: [{ name: 'sceneKey', type: 'string' }] },
    createScene: {
        args: [
            { name: 'sceneKey', type: 'string' },
            { name: 'name', type: 'string', optional: true },
        ],
    },
    deleteScene: { args: [{ name: 'sceneKey', type: 'string' }] },
    listScenes: { args: [] },
    getActiveScene: { args: [] },
};

// -- Helpers --

function getNodeLine(node: acorn.Node): number {
    return (node as any).loc?.start?.line ?? 0;
}

function inferType(node: acorn.Node): ArgType | null {
    switch (node.type) {
        case 'Literal': {
            const val = (node as any).value;
            if (typeof val === 'string') return 'string';
            if (typeof val === 'number') return 'number';
            if (typeof val === 'boolean') return 'boolean';
            return null;
        }
        case 'TemplateLiteral': return 'string';
        case 'BinaryExpression': {
            const op = (node as any).operator;
            if (op === '+') {
                const left = inferType((node as any).left);
                if (left === 'string') return 'string';
                const right = inferType((node as any).right);
                if (right === 'string') return 'string';
                return 'number';
            }
            return 'number';
        }
        case 'UnaryExpression': return (node as any).operator === '!' ? 'boolean' : 'number';
        case 'ObjectExpression': return 'object';
        case 'ArrayExpression': return 'object';
        default: return null;
    }
}

function validateEntityOptions(obj: any, errors: SceneScriptError[], line: number) {
    for (const prop of obj.properties || []) {
        const key = prop.key?.name || prop.key?.value;
        if (!key) continue;

        if (key === 'position' || key === 'scale') {
            if (prop.value.type === 'ArrayExpression') {
                errors.push({
                    line,
                    message: `addEntity: "${key}" must be an object {x, y, z}, not an array`,
                    hint: `Use ${key}: {x: 0, y: 1, z: 0}`,
                });
            }
        }

        if (key === 'components' && prop.value.type === 'ArrayExpression') {
            for (const elem of (prop.value as any).elements || []) {
                if (!elem) continue;
                if (elem.type === 'ObjectExpression') {
                    validateComponentObject(elem, errors, getNodeLine(elem) || line);
                }
            }
        }
    }
}

function validateComponentObject(obj: any, errors: SceneScriptError[], line: number) {
    let hasType = false;
    let typeValue: string | null = null;
    let dataObj: any = null;

    for (const prop of obj.properties || []) {
        const key = prop.key?.name || prop.key?.value;
        if (key === 'type') {
            hasType = true;
            if (prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
                typeValue = prop.value.value;
                if (!VALID_COMPONENT_TYPES.has(prop.value.value)) {
                    errors.push({ line, message: `Component type "${prop.value.value}" is invalid`, hint: `Valid: ${[...VALID_COMPONENT_TYPES].join(', ')}` });
                }
            }
        }
        if (key === 'data') dataObj = prop.value;
    }

    if (!hasType) {
        errors.push({ line, message: 'Component object missing "type" field', hint: 'Use {type: "RigidbodyComponent", data: {bodyType: "dynamic"}}' });
    }

    if (typeValue === 'ColliderComponent' && dataObj?.type === 'ObjectExpression') {
        for (const prop of dataObj.properties || []) {
            const key = prop.key?.name || prop.key?.value;
            if (key === 'shapeType' && prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
                if (!VALID_COLLIDER_SHAPES.has(prop.value.value)) {
                    errors.push({ line, message: `Invalid shapeType "${prop.value.value}"`, hint: `Valid: ${[...VALID_COLLIDER_SHAPES].join(', ')}` });
                }
            }
        }
    }

    if (typeValue === 'RigidbodyComponent' && dataObj?.type === 'ObjectExpression') {
        for (const prop of dataObj.properties || []) {
            const key = prop.key?.name || prop.key?.value;
            if (key === 'bodyType' && prop.value.type === 'Literal' && typeof prop.value.value === 'string') {
                if (!VALID_BODY_TYPES.has(prop.value.value)) {
                    errors.push({ line, message: `Invalid bodyType "${prop.value.value}"`, hint: `Valid: ${[...VALID_BODY_TYPES].join(', ')}` });
                }
            }
        }
    }
}

// -- Main Analyzer --

export function analyzeSceneScriptAST(code: string): SceneScriptError[] {
    const errors: SceneScriptError[] = [];

    let ast: acorn.Node;
    try {
        ast = acorn.parse(code, { ecmaVersion: 2022, sourceType: 'script', locations: true });
    } catch (e: any) {
        errors.push({ line: e.loc?.line ?? 0, message: `Syntax error: ${e.message}`, hint: 'Fix the JavaScript syntax' });
        return errors;
    }

    walk(ast, (node) => {
        if (node.type !== 'CallExpression') return;

        const callee = (node as any).callee;

        // Check scene.* method calls
        if (callee?.type === 'MemberExpression' &&
            callee.object?.type === 'Identifier' &&
            callee.object.name === 'scene' &&
            callee.property?.type === 'Identifier') {

            const methodName = callee.property.name;
            const args = (node as any).arguments || [];
            const line = getNodeLine(node);

            const schema = SCENE_API[methodName];
            if (!schema) {
                errors.push({ line, message: `scene.${methodName}() is not a valid API method`, hint: `Valid: ${Object.keys(SCENE_API).join(', ')}` });
                return;
            }

            const minArgs = schema.args.filter(a => !a.optional).length;
            const maxArgs = schema.args.length;
            if (args.length < minArgs) {
                errors.push({
                    line,
                    message: `scene.${methodName}(): expected at least ${minArgs} arg(s), got ${args.length}`,
                    hint: `scene.${methodName}(${schema.args.map(a => a.name + ': ' + a.type).join(', ')})`,
                });
            } else if (args.length > maxArgs) {
                errors.push({
                    line,
                    message: `scene.${methodName}(): expected at most ${maxArgs} arg(s), got ${args.length}`,
                    hint: `scene.${methodName}(${schema.args.map(a => a.name + ': ' + a.type).join(', ')})`,
                });
            }

            for (let i = 0; i < Math.min(args.length, schema.args.length); i++) {
                const expected = schema.args[i];
                if (expected.type === 'any') continue;
                const actual = inferType(args[i]);
                if (actual !== null && actual !== expected.type) {
                    // Allow boolean where number expected (true/false as 1/0)
                    if (expected.type === 'number' && actual === 'boolean') continue;
                    errors.push({
                        line,
                        message: `scene.${methodName}(): arg "${expected.name}" expected ${expected.type}, got ${actual}`,
                        hint: `scene.${methodName}(${schema.args.map(a => a.name + ': ' + a.type).join(', ')})`,
                    });
                }
            }

            if (schema.validate) schema.validate(args, errors, line);
        }

        // Check for Component() function calls (common mistake)
        if (callee?.type === 'Identifier' && callee.name.endsWith('Component') && VALID_COMPONENT_TYPES.has(callee.name)) {
            errors.push({
                line: getNodeLine(node),
                message: `${callee.name}() is not a function`,
                hint: `Use scene.addComponent("entity", "${callee.name}", {...})`,
            });
        }
    });

    return errors;
}

function walk(node: any, visitor: (node: acorn.Node) => void) {
    if (!node || typeof node !== 'object') return;
    visitor(node);
    for (const key of Object.keys(node)) {
        const child = node[key];
        if (Array.isArray(child)) {
            for (const c of child) {
                if (c && typeof c.type === 'string') walk(c, visitor);
            }
        } else if (child && typeof child.type === 'string') {
            walk(child, visitor);
        }
    }
}
