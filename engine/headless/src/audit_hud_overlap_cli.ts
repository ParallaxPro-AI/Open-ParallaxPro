#!/usr/bin/env node
/**
 * audit_hud_overlap_cli.ts — sweep every shipped game template under
 *   engine/backend/.../game_templates/v0.1/
 * and report HUD panel overlaps using the same analyzer as the
 * `hud_panels_no_overlap` playtest invariant.
 *
 * Usage (from repo root):
 *   bash audit_hud_overlap.sh
 *   # or directly:
 *   tsx engine/headless/src/audit_hud_overlap_cli.ts
 *
 * Exit code: 0 if every template passes, 1 if any template has overlaps.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeFlow, Overlap } from './hud_overlap.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// engine/headless/src → engine/backend/src/ws/services/pipeline/reusable_game_components
const RGC = path.resolve(
  here, '..', '..', 'backend', 'src', 'ws', 'services', 'pipeline',
  'reusable_game_components',
);
const TEMPLATE_ROOT = path.join(RGC, 'game_templates', 'v0.1');
const UI_ROOT = path.join(RGC, 'ui', 'v0.1');

function loadAllUiHtmls(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else if (entry.name.endsWith('.html')) {
        const ref = `${prefix}${entry.name.replace(/\.html$/, '')}`;
        out[ref] = fs.readFileSync(full, 'utf-8');
      }
    }
  };
  walk(UI_ROOT, '');
  return out;
}

function fmtBox(o: Overlap['a']): string {
  return `${o.ref} (${o.selector}) [${o.anchor} y:${o.y0}-${o.y1} x:${o.x0}-${o.x1}${o.sizeExact ? '' : '*'}]`;
}

function main(): void {
  if (!fs.existsSync(TEMPLATE_ROOT)) {
    process.stderr.write(`Templates dir not found: ${TEMPLATE_ROOT}\n`);
    process.exit(2);
  }
  const htmls = loadAllUiHtmls();
  const templates = fs.readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  const failing: Array<{ id: string; overlaps: Overlap[] }> = [];
  let totalOverlaps = 0;
  for (const id of templates) {
    const flowPath = path.join(TEMPLATE_ROOT, id, '01_flow.json');
    if (!fs.existsSync(flowPath)) continue;
    let flow: any;
    try { flow = JSON.parse(fs.readFileSync(flowPath, 'utf-8')); }
    catch (e: any) {
      process.stderr.write(`[${id}] flow parse error: ${e.message}\n`);
      continue;
    }
    const overlaps = analyzeFlow(flow, htmls);
    if (overlaps.length > 0) {
      failing.push({ id, overlaps });
      totalOverlaps += overlaps.length;
    }
  }

  process.stdout.write(`HUD overlap audit — ${templates.length} templates checked\n`);
  if (failing.length === 0) {
    process.stdout.write(`PASS — all ${templates.length} templates clean.\n`);
    process.exit(0);
  }

  process.stdout.write(`FAIL — ${failing.length}/${templates.length} templates have overlaps (${totalOverlaps} total).\n\n`);
  for (const { id, overlaps } of failing) {
    process.stdout.write(`▸ ${id}  (${overlaps.length})\n`);
    for (const o of overlaps) {
      process.stdout.write(`    [state: ${o.state}] ${o.reason}\n`);
      process.stdout.write(`        A: ${fmtBox(o.a)}\n`);
      process.stdout.write(`        B: ${fmtBox(o.b)}\n`);
    }
  }
  process.stdout.write(`\n(* = size estimated from CSS fallbacks, not explicit width/height)\n`);
  process.exit(1);
}

main();
