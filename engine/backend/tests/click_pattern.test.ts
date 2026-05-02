/**
 * Click-pattern lint for reusable_game_components — mirrors lint #14 in
 * validate_assembler_script.js so the library itself can't regress.
 *
 * The bug: a script that subscribes to `cursor_move` AND polls
 * `isKeyPressed("MouseLeft" / "MouseRight")` cache-and-poll's the cursor
 * position, which silently breaks taps on touch devices. ui_bridge emits
 * `cursor_move` and then `cursor_click` synchronously on the press frame;
 * if the script ticks before ui_bridge in the frame, the cached
 * `_cursorX/_cursorY` is one tap stale. Consume `cursor_click` /
 * `cursor_right_click` events directly instead — the payload's `d.x` /
 * `d.y` is always the press-frame coords. (Reference good patterns:
 * chess_interaction.ts, rts_input.ts, kitchen_master_engine.ts.)
 *
 * Run: npx tsx --test tests/click_pattern.test.ts
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RGC_DIR = path.join(__dirname, '../src/ws/services/pipeline/reusable_game_components');

// Engine-machinery scripts that legitimately bridge raw input events
// into the cursor abstraction — they are the SOURCE of the cursor_move /
// cursor_click events the rule says to consume, so the rule doesn't
// apply to them. Mirror of ENGINE_MACHINERY_RE in
// validate_assembler_script.js.
const ENGINE_MACHINERY_RE = /(^|\/)(ui_bridge|mp_bridge|fsm_driver|_entity_label|event_definitions|_event_validator)(_[^/]*)?\.ts$/;

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

function detectClickPattern(source: string): string | null {
    const hasCursorMove = /\.events\.ui\.on\(\s*["']cursor_move["']/.test(source);
    if (!hasCursorMove) return null;
    const pollLeft = /isKeyPressed\(\s*["']MouseLeft["']\s*\)/.test(source);
    const pollRight = /isKeyPressed\(\s*["']MouseRight["']\s*\)/.test(source);
    if (!pollLeft && !pollRight) return null;
    if (pollLeft && pollRight) return 'MouseLeft + MouseRight';
    return pollLeft ? 'MouseLeft' : 'MouseRight';
}

describe('library scripts use cursor_click events, not cached cursor_move + MouseLeft poll', () => {
    for (const kind of ['behaviors', 'systems']) {
        const dir = path.join(RGC_DIR, kind, 'v0.1');
        const files = walkFiles(dir);

        describe(kind, () => {
            for (const file of files) {
                const rel = file.replace(dir + '/', '');
                if (ENGINE_MACHINERY_RE.test(file)) continue;
                it(rel, () => {
                    const src = fs.readFileSync(file, 'utf-8');
                    const which = detectClickPattern(src);
                    assert.equal(
                        which, null,
                        rel + ' caches cursor_move and polls isKeyPressed("' + which + '"). ' +
                        'On touch devices a tap is the only event that moves the cursor — if ' +
                        'this script ticks before ui_bridge in the frame, the cached cursor ' +
                        'is one tap stale and the action lands at the previous click. ' +
                        'Subscribe to cursor_click (and cursor_right_click) instead and use ' +
                        "the event's d.x / d.y directly. Reference: chess_interaction.ts, " +
                        'rts_input.ts, kitchen_master_engine.ts.'
                    );
                });
            }
        });
    }
});
