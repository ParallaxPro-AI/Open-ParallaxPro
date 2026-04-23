import { InvariantResult } from './invariants.js';
import { PlaytestFailure } from './playtest.js';

export interface Verdict {
  pass: boolean;
  invariants: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    failures: Array<{ name: string; code: string; message: string; detail: any }>;
  };
  authored: {
    total: number;
    passed: number;
    failed: number;
    failures: Array<{ name: string; code: string; message: string; detail: any }>;
  };
  scriptErrors: Array<{ source: string; message: string }>;
  durationMs: number;
}

export function buildVerdict(
  invariantResults: InvariantResult[],
  authoredResults: Array<{ name: string; failure: PlaytestFailure | null }>,
  scriptErrors: Array<{ source: string; message: string }>,
  durationMs: number,
): Verdict {
  const invFailures = invariantResults.filter(r => r.failure).map(r => ({
    name: r.name,
    code: r.failure!.code,
    message: r.failure!.hint,
    detail: r.failure!.detail,
  }));
  const authFailures = authoredResults.filter(r => r.failure).map(r => ({
    name: r.name,
    code: r.failure!.code,
    message: r.failure!.hint,
    detail: r.failure!.detail,
  }));
  const invSkipped = invariantResults.filter((r: any) => r.skipped).length;
  return {
    pass: invFailures.length === 0 && authFailures.length === 0,
    invariants: {
      total: invariantResults.length,
      passed: invariantResults.filter(r => !r.failure && !(r as any).skipped).length,
      failed: invFailures.length,
      skipped: invSkipped,
      failures: invFailures,
    },
    authored: {
      total: authoredResults.length,
      passed: authoredResults.filter(r => !r.failure).length,
      failed: authFailures.length,
      failures: authFailures,
    },
    scriptErrors: scriptErrors.slice(0, 10),
    durationMs,
  };
}

/** Compact, LLM-friendly verdict printout. One line on pass, 3-10 on fail. */
export function renderHuman(v: Verdict): string {
  if (v.pass) {
    return `PASS  invariants(${v.invariants.passed}/${v.invariants.total - v.invariants.skipped})${v.invariants.skipped ? ` skipped=${v.invariants.skipped}` : ''} authored(${v.authored.passed}/${v.authored.total}) took ${v.durationMs}ms`;
  }
  const lines: string[] = [];
  lines.push(`FAIL  invariants(${v.invariants.passed}/${v.invariants.total - v.invariants.skipped}) authored(${v.authored.passed}/${v.authored.total}) took ${v.durationMs}ms`);
  for (const f of v.invariants.failures) {
    lines.push(`  ✗ invariant=${f.name} code=${f.code}`);
    lines.push(`    ${f.message}`);
    if (f.detail?.hint && typeof f.detail.hint === 'string') lines.push(`    hint: ${f.detail.hint}`);
    const compactDetail = compactJson(f.detail, 180);
    if (compactDetail) lines.push(`    detail: ${compactDetail}`);
  }
  for (const f of v.authored.failures) {
    lines.push(`  ✗ scenario=${f.name} code=${f.code}`);
    lines.push(`    ${f.message}`);
  }
  return lines.join('\n');
}

function compactJson(o: any, maxLen: number): string {
  try {
    const s = JSON.stringify(o, (_k, v) => (typeof v === 'number' ? Number(v.toFixed(3)) : v));
    if (!s || s === '{}') return '';
    if (s.length <= maxLen) return s;
    return s.slice(0, maxLen - 3) + '...';
  } catch { return ''; }
}
