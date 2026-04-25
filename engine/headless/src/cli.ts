#!/usr/bin/env node
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
