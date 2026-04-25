#!/usr/bin/env node
// Tiny shim that runs the headless playtest CLI via tsx.
//
// Two install paths:
//
//   1. `npm link` from engine/headless/ on a developer machine — this
//      script ends up on PATH as `playtest`, and `tsx` resolves from
//      engine/headless/node_modules/.bin/tsx (installed by npm install).
//
//   2. The Docker sandbox image — its own `/usr/local/bin/playtest`
//      wrapper invokes `tsx` against the bind-mounted engine source
//      directly without going through this shim. This file exists for
//      install-path #1 and as the canonical declared `bin` entry in
//      package.json.
//
// First positional arg is the project directory; remaining args pass
// straight through to cli.ts (`--json`, `--timeout <secs>`).

import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(__dirname, '..', 'src', 'cli.ts');

// Prefer the local node_modules tsx (matches the version pinned in
// package.json); fall through to a global `tsx` on PATH.
const localTsx = path.join(__dirname, '..', 'node_modules', '.bin', 'tsx');
const tsxBin = fs.existsSync(localTsx) ? localTsx : 'tsx';

const result = spawnSync(tsxBin, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
});
if (result.error) {
  process.stderr.write(`playtest: failed to spawn ${tsxBin}: ${result.error.message}\n`);
  process.exit(2);
}
process.exit(result.status ?? 1);
