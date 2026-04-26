#!/usr/bin/env node

// Silence Rapier WASM init's harmless "using deprecated parameters for the
// initialization function; pass a single object instead" warning before
// any other module loads (the existing patches in runtime.ts /
// physics_system.ts run AFTER their own imports, by which time Rapier's
// init has already printed). Patch both stdout/stderr.write and
// console.warn so it can't leak through whichever channel the WASM
// bridge happens to use this version. Filtering is line-prefix-based
// and module-local — only this exact deprecation gets dropped.
{
  const NOISE = 'using deprecated parameters for the initialization function';
  const wrap = (orig: typeof process.stdout.write): typeof process.stdout.write => {
    return ((chunk: any, ...rest: any[]) => {
      if (typeof chunk === 'string' && chunk.includes(NOISE)) return true;
      if (chunk && typeof chunk === 'object' && typeof chunk.toString === 'function') {
        const s = chunk.toString();
        if (typeof s === 'string' && s.includes(NOISE)) return true;
      }
      return orig.call(process.stdout, chunk, ...rest);
    }) as any;
  };
  process.stdout.write = wrap(process.stdout.write.bind(process.stdout));
  process.stderr.write = wrap(process.stderr.write.bind(process.stderr));
  const origWarn = console.warn.bind(console);
  console.warn = (...args: any[]) => {
    for (const a of args) {
      if (typeof a === 'string' && a.includes(NOISE)) return;
    }
    origWarn(...args);
  };
}

import { runPlaytest } from './index.js';
import { renderHuman } from './verdict.js';

function parseArgs(argv: string[]): { dir: string; json: boolean; timeoutMs?: number } {
  let dir = '.';
  let json = false;
  let timeoutMs: number | undefined;
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { json = true; continue; }
    if (a === '--timeout' && argv[i + 1]) { timeoutMs = Number(argv[++i]) * 1000; continue; }
    if (a.startsWith('--')) continue;
    dir = a;
  }
  return { dir, json, timeoutMs };
}

async function main() {
  const { dir, json, timeoutMs } = parseArgs(process.argv);
  try {
    const v = await runPlaytest(dir, { timeoutMs });
    if (json) process.stdout.write(JSON.stringify(v, null, 2) + '\n');
    else process.stdout.write(renderHuman(v) + '\n');
    process.exit(v.pass ? 0 : 1);
  } catch (e: any) {
    process.stderr.write(`PLAYTEST_CRASH ${e?.message ?? e}\n`);
    if (e?.stack) process.stderr.write(String(e.stack).split('\n').slice(0, 5).join('\n') + '\n');
    process.exit(2);
  }
}

main();
