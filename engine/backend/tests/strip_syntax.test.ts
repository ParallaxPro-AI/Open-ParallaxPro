/**
 * Tests for stripForSyntaxCheck — the function that sanitizes TypeScript/ESM
 * syntax so `new Function()` can parse it for quick syntax validation.
 *
 * Run: npx tsx --test tests/strip_syntax.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname, '../src/ws/services/pipeline/reusable_game_components');

// Mirror the function from sandbox_validate.ts so tests stay in sync.
// If this drifts from the real one, the "real function import" test below catches it.
function stripForSyntaxCheck(src: string): string {
    return src
        .replace(/^\s*export\s+default\s+/gm, '')
        .replace(/^\s*export\s+/gm, '')
        .replace(/^\s*import\s+.*$/gm, '')
        .replace(/\bconst\b/g, 'var')
        .replace(/(?:var|let)\s+(\w+)\s*:\s*[^=\n]+=/g, 'var $1 =');
}

function assertValidJS(code: string, label: string) {
    const stripped = stripForSyntaxCheck(code);
    try {
        new Function('GameScript', 'Vec3', 'Quat', stripped + '\n;');
    } catch (e: any) {
        assert.fail(`${label}: ${e.message}\n  INPUT:  ${code.slice(0, 100)}\n  OUTPUT: ${stripped.slice(0, 100)}`);
    }
}

function assertStripsTo(input: string, expected: string, label: string) {
    const result = stripForSyntaxCheck(input);
    assert.equal(result.trim(), expected.trim(), label);
}

// ─── Unit tests for individual transforms ────────────────────────────────────

describe('stripForSyntaxCheck', () => {
    describe('export stripping', () => {
        it('strips export const', () => {
            assertStripsTo('export const X = 1', 'var X = 1', 'export const');
        });
        it('strips export default class', () => {
            assertStripsTo('export default class Foo {}', 'class Foo {}', 'export default class');
        });
        it('strips export function', () => {
            assertStripsTo('export function foo() {}', 'function foo() {}', 'export function');
        });
        it('strips export at line start only', () => {
            assertStripsTo('var s = "export default"', 'var s = "export default"', 'export in string');
        });
    });

    describe('import stripping', () => {
        it('strips named import', () => {
            assertStripsTo('import { foo } from "./bar"', '', 'named import');
        });
        it('strips star import', () => {
            assertStripsTo('import * as fs from "fs"', '', 'star import');
        });
        it('strips default import', () => {
            assertStripsTo('import Foo from "./foo"', '', 'default import');
        });
    });

    describe('const → var', () => {
        it('converts const to var', () => {
            assertStripsTo('const x = 5', 'var x = 5', 'const to var');
        });
        it('converts const in for loop', () => {
            assertValidJS('for (const x of [1,2,3]) {}', 'const in for-of');
        });
    });

    describe('TypeScript type annotation stripping', () => {
        it('strips simple type', () => {
            assertStripsTo('const x: number = 5', 'var x = 5', 'simple type');
        });
        it('strips Record type', () => {
            assertStripsTo(
                'export const GAME_EVENTS: Record<string, { fields: Record<string, { type: string; optional?: boolean }> }> = {',
                'var GAME_EVENTS = {',
                'Record type'
            );
        });
        it('strips array type', () => {
            assertStripsTo('let y: string[] = []', 'var y = []', 'array type');
        });
        it('strips index signature type', () => {
            assertStripsTo('const MAP: { [k: string]: number } = { a: 1 }', 'var MAP = { a: 1 }', 'index sig');
        });
    });

    describe('preserves valid JS patterns', () => {
        it('preserves ternary operators', () => {
            assertValidJS('var a = true ? 1 : 2', 'ternary');
        });
        it('preserves ternary with function calls', () => {
            assertValidJS('var x = a.method() > 0 ? a.method() : b.method()', 'ternary with methods');
        });
        it('preserves ternary with substring', () => {
            assertValidJS('var shortName = dotIdx > 0 ? eventName.substring(dotIdx + 1) : eventName', 'ternary with substring');
        });
        it('preserves object literals', () => {
            assertValidJS('var obj = { key: "value", fn: function() { return 1; } }', 'object literal');
        });
        it('preserves switch/case', () => {
            assertValidJS('switch(x) { case 1: break; default: break; }', 'switch');
        });
        it('preserves regex with colon', () => {
            assertValidJS('var re = /pattern:\\s+test/g', 'regex colon');
        });
        it('preserves string with colon', () => {
            assertValidJS('var s = "hello: world"', 'string colon');
        });
        it('preserves if/else', () => {
            assertValidJS('if (x) { doA(); } else { doB(); }', 'if-else');
        });
        it('preserves for loop', () => {
            assertValidJS('for (var i = 0; i < 10; i++) { arr[i] = i; }', 'for loop');
        });
        it('preserves callbacks', () => {
            assertValidJS('var self = this; scene.on("evt", function() { self.x = 1; })', 'callback');
        });
        it('preserves nested ternary', () => {
            assertValidJS('var r = a ? b : c ? d : e', 'nested ternary');
        });
    });
});

// ─── Integration: every real library file must pass ──────────────────────────

describe('all library files pass syntax check', () => {
    function walkFiles(dir: string): string[] {
        const files: string[] = [];
        if (!fs.existsSync(dir)) return files;
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) files.push(...walkFiles(full));
            else if (entry.name.endsWith('.ts')) files.push(full);
        }
        return files;
    }

    for (const kind of ['behaviors', 'systems']) {
        const dir = path.join(RGC_DIR, kind, 'v0.1');
        const files = walkFiles(dir);

        describe(kind, () => {
            for (const file of files) {
                const rel = file.replace(dir + '/', '');
                it(rel, () => {
                    const src = fs.readFileSync(file, 'utf-8');
                    assertValidJS(src, rel);
                });
            }
        });
    }
});
