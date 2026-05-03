/**
 * agent_instructions.ts — write the right CLI-specific instruction file(s)
 * into a sandbox so each agent picks up the engine docs without a Read.
 *
 * Each CLI auto-loads its own convention:
 *   claude   → CLAUDE.md
 *   codex    → AGENTS.md (or ~/.codex/AGENTS.md)
 *   opencode → AGENTS.md
 *   copilot  → .github/copilot-instructions.md (also reads AGENTS.md)
 *
 * The engine docs (CREATOR_CONTEXT.md / FIXER_CONTEXT.md) were written for
 * Claude and reference its tool surface (Write/Edit/Read PascalCase, "MULTIPLE
 * tool_use blocks per message", `--max-turns 15`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`).
 * For non-Claude CLIs we prepend a short per-tool PREAMBLE that translates
 * those Claude-isms to the target tool's surface, then append the engine doc
 * unchanged.
 *
 * Claude path is byte-equivalent to the prior behavior (CLAUDE.md and AGENTS.md
 * both contain the engine doc, no preamble). This keeps the warm-session
 * content hash unchanged.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import type { CLIName } from './cli_runner.js';

export type { CLIName };

const __dirname_ai = path.dirname(fileURLToPath(import.meta.url));

const CODEX_PREAMBLE_PATH = path.join(__dirname_ai, 'CODEX_PREAMBLE.md');
const OPENCODE_PREAMBLE_PATH = path.join(__dirname_ai, 'OPENCODE_PREAMBLE.md');
const COPILOT_PREAMBLE_PATH = path.join(__dirname_ai, 'COPILOT_PREAMBLE.md');

function readPreamble(cli: Exclude<CLIName, 'claude'>): string {
    const p =
        cli === 'codex'    ? CODEX_PREAMBLE_PATH    :
        cli === 'opencode' ? OPENCODE_PREAMBLE_PATH :
        /* copilot */        COPILOT_PREAMBLE_PATH  ;
    try {
        return fs.readFileSync(p, 'utf-8');
    } catch {
        // Missing preamble shouldn't break a run — fall back to engine doc only.
        return '';
    }
}

/**
 * Write the appropriate auto-loaded instruction file(s) into `sandboxDir`.
 *
 * - claude: CLAUDE.md and AGENTS.md, both = `engineDoc` (unchanged from prior
 *   behavior — preserves warm-session content hash).
 * - codex / opencode: AGENTS.md = preamble + engineDoc.
 * - copilot: .github/copilot-instructions.md = preamble + engineDoc, plus
 *   AGENTS.md as a fallback (copilot reads both).
 */
export function writeAgentInstructions(
    sandboxDir: string,
    cli: CLIName,
    engineDoc: string,
): void {
    if (cli === 'claude') {
        fs.writeFileSync(path.join(sandboxDir, 'CLAUDE.md'), engineDoc);
        fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), engineDoc);
        return;
    }

    const preamble = readPreamble(cli);
    const combined = preamble ? preamble + engineDoc : engineDoc;

    if (cli === 'codex' || cli === 'opencode') {
        fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), combined);
        return;
    }

    // copilot
    const ghDir = path.join(sandboxDir, '.github');
    fs.mkdirSync(ghDir, { recursive: true });
    fs.writeFileSync(path.join(ghDir, 'copilot-instructions.md'), combined);
    fs.writeFileSync(path.join(sandboxDir, 'AGENTS.md'), combined);
}
