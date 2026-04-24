#!/usr/bin/env node
/**
 * Playtest regression harness.
 *
 * Reads `baseline.json`, runs `runPlaytest` against each entry's project
 * directory, and diffs the actual invariant failures against the expected
 * list. Drift in EITHER direction is flagged:
 *
 *   - NEW failure    (invariant fires on an entry that didn't expect it)
 *                    → likely a false positive from a newly added invariant
 *                       OR a legitimate new catch we want to document.
 *   - MISSING failure (expected invariant no longer fires)
 *                    → lost coverage. Was the invariant accidentally
 *                       disabled, over-tuned, or did the underlying entity
 *                       data change?
 *
 * Exit codes:
 *   0 — no drift
 *   1 — drift detected (details printed)
 *   2 — harness crashed
 *
 * Flags:
 *   --update              Rewrite baseline.json with the current results.
 *                         Use after confirming the new state is correct.
 *   --only <id>           Run a single entry by its `id` (quick iteration).
 *   --verbose             Print per-entry timing + invariant list on success.
 *   --research-dir <path> Override the research/create_game/artifacts path
 *                         (default: sibling repo at
 *                         ../../../../ParallaxPro-server/research/create_game/artifacts,
 *                         or $RESEARCH_ARTIFACTS env var).
 */

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { runPlaytest } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = path.join(__dirname, 'baseline.json');
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');  // engine/headless/regression → engine/headless → engine → repo root

interface Baseline {
  version: number;
  description: string;
  pathPrefixes: Record<string, string>;
  entries: Entry[];
}

interface Entry {
  id: string;
  label: string;
  path: string;               // "engine:xxx" | "research:xxx" | absolute | relative-to-repo-root
  expectedInvariantFailures: string[];
  expectedAuthoredStatus: 'pass' | 'fail' | 'absent';
  notes: string;
}

interface Actual {
  id: string;
  resolvedPath: string;
  invariantFailures: string[];
  authoredStatus: 'pass' | 'fail' | 'absent';
  durationMs: number;
  error?: string;
}

function parseArgs(argv: string[]): { update: boolean; only?: string; verbose: boolean; researchDir?: string } {
  const out: any = { update: false, verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--update') out.update = true;
    else if (a === '--verbose' || a === '-v') out.verbose = true;
    else if (a === '--only' && argv[i + 1]) { out.only = argv[++i]; }
    else if (a === '--research-dir' && argv[i + 1]) { out.researchDir = argv[++i]; }
  }
  return out;
}

function resolveEntryPath(entry: Entry, prefixes: Record<string, string>, researchOverride: string | undefined): string {
  let raw = entry.path;
  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0 && colonIdx < 20) {
    const prefix = raw.slice(0, colonIdx);
    const rest = raw.slice(colonIdx + 1);
    if (prefix === 'research' && researchOverride) return path.resolve(researchOverride, rest);
    const template = prefixes[prefix];
    if (template !== undefined) {
      const expanded = template.replace(/\$\{(\w+):-([^}]+)\}/g, (_m, envName, dflt) => process.env[envName] ?? dflt);
      return path.isAbsolute(expanded) ? path.join(expanded, rest) : path.resolve(REPO_ROOT, expanded, rest);
    }
  }
  if (path.isAbsolute(raw)) return raw;
  return path.resolve(REPO_ROOT, raw);
}

async function runOne(entry: Entry, prefixes: Record<string, string>, researchOverride: string | undefined): Promise<Actual> {
  const resolvedPath = resolveEntryPath(entry, prefixes, researchOverride);
  if (!fs.existsSync(resolvedPath)) {
    return {
      id: entry.id,
      resolvedPath,
      invariantFailures: [],
      authoredStatus: 'absent',
      durationMs: 0,
      error: `path does not exist: ${resolvedPath}`,
    };
  }
  const t0 = Date.now();
  try {
    const v = await runPlaytest(resolvedPath, { timeoutMs: 60_000 });
    const invariantFailures = v.invariants.failures.map(f => f.name).sort();
    let authoredStatus: 'pass' | 'fail' | 'absent' = 'absent';
    if (v.authored.total === 0) authoredStatus = 'absent';
    else if (v.authored.failed > 0) authoredStatus = 'fail';
    else authoredStatus = 'pass';
    return {
      id: entry.id,
      resolvedPath,
      invariantFailures,
      authoredStatus,
      durationMs: Date.now() - t0,
    };
  } catch (e: any) {
    return {
      id: entry.id,
      resolvedPath,
      invariantFailures: [],
      authoredStatus: 'absent',
      durationMs: Date.now() - t0,
      error: String(e?.message ?? e),
    };
  }
}

function diff(expected: string[], actual: string[]): { newlyFiring: string[]; stoppedFiring: string[] } {
  const eSet = new Set(expected);
  const aSet = new Set(actual);
  return {
    newlyFiring: actual.filter(x => !eSet.has(x)),
    stoppedFiring: expected.filter(x => !aSet.has(x)),
  };
}

async function main() {
  const args = parseArgs(process.argv);
  let baseline: Baseline;
  try {
    baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf-8'));
  } catch (e: any) {
    console.error(`ERR reading baseline.json: ${e?.message ?? e}`);
    process.exit(2);
  }

  const entries = args.only
    ? baseline.entries.filter(e => e.id === args.only)
    : baseline.entries;
  if (args.only && entries.length === 0) {
    console.error(`no entry with id="${args.only}" in baseline.json`);
    process.exit(2);
  }

  console.log(`=== playtest regression (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}) ===\n`);
  const results: Array<{ entry: Entry; actual: Actual }> = [];
  for (const entry of entries) {
    const actual = await runOne(entry, baseline.pathPrefixes, args.researchDir);
    results.push({ entry, actual });
    const d = diff(entry.expectedInvariantFailures, actual.invariantFailures);
    const drift = d.newlyFiring.length + d.stoppedFiring.length > 0 ||
                  entry.expectedAuthoredStatus !== actual.authoredStatus;
    const tag = actual.error ? 'ERROR' : drift ? 'DRIFT' : 'OK';
    const pad = actual.error ? '⚠' : drift ? '✗' : '✓';
    console.log(`${pad} [${tag}]  ${entry.id.padEnd(30)}  ${actual.durationMs}ms`);
    if (actual.error) {
      console.log(`    error: ${actual.error}`);
    } else if (drift) {
      for (const n of d.newlyFiring)   console.log(`    + ${n}  (newly firing — either a real catch we should add to baseline, or a false positive to investigate)`);
      for (const n of d.stoppedFiring) console.log(`    - ${n}  (stopped firing — lost coverage. Did the invariant get disabled / over-tuned?)`);
      if (entry.expectedAuthoredStatus !== actual.authoredStatus) {
        console.log(`    ! authored: expected=${entry.expectedAuthoredStatus}  actual=${actual.authoredStatus}`);
      }
    } else if (args.verbose) {
      console.log(`    invariants: ${actual.invariantFailures.length === 0 ? '(all pass)' : actual.invariantFailures.join(', ')}`);
      console.log(`    authored:   ${actual.authoredStatus}`);
    }
  }

  if (args.update) {
    for (const { entry, actual } of results) {
      if (actual.error) continue;  // don't update entries that errored
      entry.expectedInvariantFailures = actual.invariantFailures;
      entry.expectedAuthoredStatus = actual.authoredStatus;
    }
    // Write preserving key order.
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + '\n');
    console.log(`\nbaseline.json updated (${results.filter(r => !r.actual.error).length} entries).`);
    process.exit(0);
  }

  const driftCount = results.filter(r => r.actual.error ||
    diff(r.entry.expectedInvariantFailures, r.actual.invariantFailures).newlyFiring.length > 0 ||
    diff(r.entry.expectedInvariantFailures, r.actual.invariantFailures).stoppedFiring.length > 0 ||
    r.entry.expectedAuthoredStatus !== r.actual.authoredStatus
  ).length;
  console.log(`\n${results.length - driftCount}/${results.length} match baseline. ${driftCount} drift${driftCount === 1 ? '' : 's'}.`);
  process.exit(driftCount === 0 ? 0 : 1);
}

main().catch(e => { console.error('harness crashed:', e?.stack ?? e); process.exit(2); });
