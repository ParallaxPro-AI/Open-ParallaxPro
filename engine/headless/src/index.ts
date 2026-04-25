/**
 * Programmatic entry for the headless playtest runtime. Call runPlaytest(dir)
 * from Node code (e.g. cli_creator.ts) to get a Verdict. The CLI wraps this
 * for terminal use.
 */

import { loadGame } from './loader.js';
import { Runtime, RuntimeOptions } from './runtime.js';
import { Playtest, PlaytestFailure } from './playtest.js';
import { runInvariants, InvariantResult } from './invariants.js';
import { buildVerdict, Verdict, renderHuman } from './verdict.js';
import { syncEventDefinitions } from './sync.js';

export { Playtest, PlaytestFailure, Runtime, buildVerdict, renderHuman, loadGame, syncEventDefinitions };
export type { Verdict };

export interface RunOptions extends RuntimeOptions {
  timeoutMs?: number;
}

export async function runPlaytest(gameDir: string, opts: RunOptions = {}): Promise<Verdict> {
  const start = Date.now();

  // Auto-declare any event names referenced by project sources but missing
  // from event_definitions.ts. Idempotent — only writes if there's
  // something to append. Runs before loadGame so the loaded source is
  // post-sync.
  try { syncEventDefinitions(gameDir); } catch (e: any) {
    // Sync failure is non-fatal — the playtest will still run, and any
    // strict-mode emit failure surfaces as a real invariant failure.
    console.warn(`[runPlaytest] sync skipped: ${e?.message ?? e}`);
  }

  const files = loadGame(gameDir);

  // Missing required files is a hard fail (mirrors existing cli_creator guard).
  if (!files.flow || !files.entities) {
    return buildVerdict(
      [{ name: 'files_present', failure: new PlaytestFailure('missing_files', 'required template files missing (01_flow.json, 02_entities.json)', { hint: 'All 4 template JSONs are required: 01_flow.json, 02_entities.json, 03_worlds.json, 04_systems.json' }) }],
      [],
      [],
      Date.now() - start,
    );
  }

  let runtime: Runtime;
  try {
    runtime = new Runtime(files, opts);
  } catch (e: any) {
    return buildVerdict(
      [{ name: 'runtime_boot', failure: new PlaytestFailure('boot_error', `runtime construct: ${e?.message ?? e}`, {}) }],
      [], [], Date.now() - start,
    );
  }

  try { await runtime.boot(); }
  catch (e: any) {
    return buildVerdict(
      [{ name: 'runtime_boot', failure: new PlaytestFailure('boot_error', `runtime boot: ${e?.message ?? e}`, {}) }],
      [], [], Date.now() - start,
    );
  }

  const playtest = new Playtest(runtime);

  // Parse hints from PLAYTEST.ts if present: `gameType` / `primaryAction` exports.
  let authoredFn: ((p: Playtest) => void | Promise<void>) | null = null;
  let gameType = 'unknown';
  let primaryAction: string | undefined;
  if (files.playtest) {
    try {
      // PLAYTEST.ts contract:
      //   export const gameType = "...";
      //   export const primaryAction = "KeyW";  // optional
      //   export default async (p) => { ... }
      // We transform each export form into a local assignment, strip imports,
      // strip bare TS type annotations, then eval.
      let src = files.playtest
        .replace(/^\s*import\s+.*$/gm, '')
        .replace(/^\s*export\s+const\s+(\w+)\s*(:\s*[^=\n]+)?\s*=/gm, 'var $1 =')
        .replace(/^\s*export\s+(var|let)\s+(\w+)\s*(:\s*[^=\n]+)?\s*=/gm, 'var $2 =')
        .replace(/^\s*export\s+default\s+/gm, '__playtest_default__ = ')
        .replace(/\bconst\b/g, 'var');
      const wrapperSrc = `
        var gameType = 'unknown';
        var primaryAction = undefined;
        var __playtest_default__ = null;
        ${src}
        return { gameType: gameType, primaryAction: primaryAction, fn: __playtest_default__ };
      `;
      const runner = new Function('Playtest', 'console', wrapperSrc);
      const out = runner(Playtest, console);
      if (out?.gameType) gameType = out.gameType;
      if (out?.primaryAction) primaryAction = out.primaryAction;
      if (typeof out?.fn === 'function') authoredFn = out.fn;
    } catch (e: any) {
      return buildVerdict(
        [{ name: 'playtest_parse', failure: new PlaytestFailure('playtest_parse', `PLAYTEST.ts parse error: ${e?.message ?? e}`, { hint: 'PLAYTEST.ts must have: export const gameType = "..."; export const primaryAction = "..."; export default async (p) => { ... }' }) }],
        [], [], Date.now() - start,
      );
    }
  }

  // Run invariants
  const invariantResults = runInvariants(playtest, { gameType, primaryAction });

  // Run authored scenarios (one "scenario" per PLAYTEST, but we wrap it so we
  // get a named result). Skipped when invariants fail so the agent fixes the
  // fundamentals before we torture-test specific mechanics.
  const authoredResults: Array<{ name: string; failure: PlaytestFailure | null }> = [];
  const anyInvariantFailed = invariantResults.some(r => r.failure);
  if (authoredFn && !anyInvariantFailed) {
    try {
      const result = authoredFn(playtest);
      if (result && typeof (result as any).then === 'function') {
        await Promise.race([
          result,
          new Promise((_, reject) => setTimeout(() => reject(new Error(`authored playtest exceeded ${opts.timeoutMs ?? 30000}ms`)), opts.timeoutMs ?? 30000)),
        ]);
      }
      authoredResults.push({ name: 'authored', failure: null });
    } catch (e: any) {
      const f = e instanceof PlaytestFailure
        ? e
        : new PlaytestFailure('authored_crash', `PLAYTEST threw: ${e?.message ?? e}`, { stack: String(e?.stack ?? '').split('\n').slice(0, 3).join(' | ') });
      authoredResults.push({ name: 'authored', failure: f });
    }
  }

  return buildVerdict(invariantResults, authoredResults, playtest.errors(), Date.now() - start);
}
