/**
 * sync.ts — Auto-declare event names referenced by project sources but
 * missing from `systems/event_definitions.ts`.
 *
 * Why this exists: the runtime EventBus runs in strict mode — any
 * `events.game.emit('foo')` for a name not declared in `event_definitions.ts`
 * throws at runtime. The CREATE_GAME / FIX_GAME pipeline can leave the
 * project in a half-synced state (e.g. a behavior added a new emit but the
 * agent forgot to update the event defs), and the next playtest would
 * crash on first emit. This module scans the project, finds undeclared
 * event names, and appends permissive `data: any` placeholder entries so
 * the playtest can run instead of stack-tracing.
 *
 * Idempotent: if every referenced event is already declared, the file is
 * not touched. Safe to call before every playtest.
 *
 * Conservative: only matches `events.game.(on|emit)('literal')` /
 * `.emit("literal")` plus `01_flow.json`'s `"emit:game.X"` and
 * `"game_event:X"` strings. Dynamic / computed names are left alone so
 * they surface as real assembler/runtime failures instead of getting
 * silently auto-declared with the wrong schema.
 *
 * Mirrors the implementation that previously lived inline in
 * cli_creator.ts. Moved here so both the orchestrator-side `runPlaytest`
 * call and the in-sandbox `playtest` invocation get the same behaviour
 * without code duplication.
 */

import * as fs from 'fs';
import * as path from 'path';

export function syncEventDefinitions(projectDir: string): { appended: string[] } {
  const evtPath = path.join(projectDir, 'systems', 'event_definitions.ts');
  if (!fs.existsSync(evtPath)) return { appended: [] };
  const src = fs.readFileSync(evtPath, 'utf-8');

  // Parse declared event names — same regex shape the assembler uses.
  const declared = new Set<string>();
  for (const m of src.matchAll(/^\s+(\w+)\s*:\s*\{/gm)) {
    declared.add(m[1]);
  }
  for (const nonEvent of ['fields', 'type', 'optional']) declared.delete(nonEvent);

  // Walk all TS sources and collect referenced event names.
  const referenced = new Set<string>();
  const eventCallRe = /events\.game\.(?:on|emit)\s*\(\s*['"]([^'"]+)['"]/g;
  const scanFile = (p: string) => {
    try {
      const s = fs.readFileSync(p, 'utf-8');
      for (const m of s.matchAll(eventCallRe)) referenced.add(m[1]);
    } catch {
      // ignore unreadable files
    }
  };
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && full.endsWith('.ts') && ent.name !== 'event_definitions.ts') scanFile(full);
    }
  };
  walk(path.join(projectDir, 'behaviors'));
  walk(path.join(projectDir, 'systems'));
  walk(path.join(projectDir, 'scripts'));

  // 01_flow.json `emit:game.X` actions and `game_event:X` transitions also count.
  try {
    const flowSrc = fs.readFileSync(path.join(projectDir, '01_flow.json'), 'utf-8');
    for (const m of flowSrc.matchAll(/"emit:game\.([^"]+)"/g)) referenced.add(m[1]);
    for (const m of flowSrc.matchAll(/"game_event:([^"]+)"/g)) referenced.add(m[1]);
  } catch {
    // flow file may not yet exist on a partially-built project
  }

  const undeclared = [...referenced].filter(n => !declared.has(n));
  if (undeclared.length === 0) return { appended: [] };

  // Append entries inside the GAME_EVENTS object literal, just before
  // the closing brace. Heuristic: the LAST `};` on its own line at
  // file end. Matches the canonical file shape (entries indented 4
  // spaces, closing `};` on its own line).
  const closingRe = /\n\s*\};\s*$/m;
  const closeMatch = src.match(closingRe);
  if (!closeMatch || closeMatch.index === undefined) {
    console.warn('[sync] could not locate closing brace of GAME_EVENTS; skipping auto-decl');
    return { appended: [] };
  }
  const insertAt = closeMatch.index;
  const lines: string[] = [];
  lines.push('');
  lines.push('    // auto-declared by playtest sync — these events were emitted/listened-for in');
  lines.push('    // project sources but not declared. Permissive `data: any` schema is a');
  lines.push('    // placeholder; tighten if the payload shape is non-trivial.');
  for (const name of undeclared) {
    lines.push(`    ${name}: { fields: { data: { type: 'any', optional: true } } },`);
  }
  const updated = src.slice(0, insertAt) + '\n' + lines.join('\n') + src.slice(insertAt);
  fs.writeFileSync(evtPath, updated, 'utf-8');
  return { appended: undeclared };
}
