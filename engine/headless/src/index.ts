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

  // Authored playtest scenarios + their hint constants are DISABLED
  // (2026-04-26). The headless playtest no longer parses PLAYTEST.ts —
  // the loader doesn't even read the file. Invariants run with
  // gameType='unknown' and no primaryAction; gameType-gated invariants
  // self-skip in that mode. Past hand-rolled scenarios were the dominant
  // false-positive source (input-simulation gaps, HTML-button-click
  // gaps); the cost of those was higher than the value of the gating
  // hints, so we cut the whole feature.
  const gameType = 'unknown';
  const primaryAction: string | undefined = undefined;

  // Run invariants
  const invariantResults = runInvariants(playtest, { gameType, primaryAction });

  // No authored scenarios — see the disabled-feature note above the
  // gameType declaration. authoredResults stays empty so the verdict
  // formatter renders `authored(0/0)` regardless.
  const authoredResults: Array<{ name: string; failure: PlaytestFailure | null }> = [];

  return buildVerdict(invariantResults, authoredResults, playtest.errors(), Date.now() - start);
}
