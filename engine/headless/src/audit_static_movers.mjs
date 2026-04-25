#!/usr/bin/env node
// Static audit for the "moving entity is static-rigidbody" bug class.
//
// The runtime invariant `static_bodies_dont_move` in invariants.ts catches
// this at playtest time. This standalone script does the equivalent purely
// from the JSON + script source so we can sweep all 41 templates without
// booting Rapier per template.
//
// Detection (two patterns that produce the same bug):
//   1. A behavior script attached to entity E calls
//      `this.scene.setPosition(this.entity.id, …)` inside onUpdate. If E's
//      physics.type isn't kinematic/dynamic, the static collider gets
//      teleported under riders without triggering carryKinematicRiders.
//   2. A system referenced by 04_systems.json calls
//      `findEntitiesByTag("X")` (or findEntitiesByName) and then setPosition
//      on the result inside onUpdate. Any entity in 02_entities.json with
//      tag X must not be static.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../../');
const RGC = path.join(REPO_ROOT, 'engine/backend/src/ws/services/pipeline/reusable_game_components');
const TEMPLATES_DIR = path.join(RGC, 'game_templates/v0.1');
const BEHAVIORS_DIR = path.join(RGC, 'behaviors/v0.1');
const SYSTEMS_DIR = path.join(RGC, 'systems/v0.1');

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }
function tryRead(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } }

// Strip /* */ and // comments so we don't false-match commented-out calls.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}

// Locate the source for a behavior or system path. Templates reference
// scripts as relative paths under behaviors/ or systems/ (e.g.
// "ai/moving_platform.ts" or "gameplay/platformer_level.ts").
function loadScript(rel) {
  const r = rel.replace(/^\/+/, '');
  return tryRead(path.join(BEHAVIORS_DIR, r)) ?? tryRead(path.join(SYSTEMS_DIR, r));
}

function physicsType(def) {
  // level_assembler.ts: `bodyType: p.type || 'static'` for any meshed entity
  // unless physics === false.
  if (def?.physics === false) return null;       // explicitly opted out of physics
  if (!def?.mesh) return null;                   // no mesh → no auto rigidbody
  return (def?.physics?.type || 'static').toLowerCase();
}

// Find onUpdate body inside a script. Returns the substring or "" on miss.
function extractOnUpdate(src) {
  const m = src.match(/onUpdate\s*\([^)]*\)\s*\{/);
  if (!m) return '';
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

const findings = [];   // { template, kind, entity, tag, script, reason }
const summary = [];

const templates = fs.readdirSync(TEMPLATES_DIR)
  .filter(d => fs.statSync(path.join(TEMPLATES_DIR, d)).isDirectory())
  .sort();

for (const tmpl of templates) {
  const tDir = path.join(TEMPLATES_DIR, tmpl);
  const entitiesPath = path.join(tDir, '02_entities.json');
  const systemsPath = path.join(tDir, '04_systems.json');
  if (!fs.existsSync(entitiesPath)) continue;

  const ents = readJSON(entitiesPath);
  const defs = ents.definitions ?? ents;        // some templates may omit the wrapper

  // Index: tag → entity names with that tag (and their physics.type).
  const tagToEntities = new Map();
  for (const [name, def] of Object.entries(defs)) {
    const tags = Array.isArray(def?.tags) ? def.tags : [];
    for (const t of tags) {
      if (typeof t !== 'string') continue;
      if (!tagToEntities.has(t)) tagToEntities.set(t, []);
      tagToEntities.get(t).push({ name, type: physicsType(def) });
    }
  }

  // ── Pattern 1: behaviors that move `this.entity` ──
  for (const [name, def] of Object.entries(defs)) {
    const ptype = physicsType(def);
    if (ptype === null) continue;                     // no physics — not our concern
    if (ptype === 'kinematic' || ptype === 'dynamic') continue;
    for (const beh of def.behaviors ?? []) {
      const src = loadScript(beh.script ?? beh.path ?? '');
      if (!src) continue;
      const noComments = stripComments(src);
      const onUpd = extractOnUpdate(noComments);
      if (!onUpd) continue;
      // Match scene.setPosition(this.entity.id, …) or scene.setPosition(this.entity, …)
      if (/\bscene\.setPosition\s*\(\s*this\.entity(\.id)?\s*,/.test(onUpd)) {
        findings.push({
          template: tmpl,
          kind: 'behavior_moves_static_self',
          entity: name,
          tag: null,
          script: beh.script,
          reason: `behavior "${beh.script}" calls scene.setPosition(this.entity.id, …) in onUpdate, but entity "${name}" is ${ptype}`,
        });
      }
    }
  }

  // ── Pattern 2: systems that move entities-by-tag ──
  let systemsCfg = null;
  if (fs.existsSync(systemsPath)) {
    try { systemsCfg = readJSON(systemsPath); } catch {}
  }
  // 04_systems.json may use either { systems: { name: {...}, ... } } (object map)
  // or { systems: [ {name, script, ...}, ... ] } (array). Normalize.
  const systems = systemsCfg?.systems ?? systemsCfg ?? [];
  const sysList = Array.isArray(systems)
    ? systems
    : (systems && typeof systems === 'object' ? Object.values(systems) : []);
  for (const sys of sysList) {
    const src = loadScript(sys.script ?? sys.path ?? '');
    if (!src) continue;
    const noComments = stripComments(src);
    const onUpd = extractOnUpdate(noComments);
    if (!onUpd) continue;

    if (!/\bsetPosition\s*\(/.test(onUpd)) continue;

    // Correlate: only fire when we can connect a findEntitiesByTag("X")
    // assignment to a downstream setPosition whose target argument
    // textually mentions the bound variable. A plain co-occurrence check
    // false-positives whenever a system happens to query enemies for hit
    // detection but writes setPosition to a different entity (collectibles,
    // movers, the player).
    const tagBindings = [...onUpd.matchAll(
      /(?:var|let|const)\s+(\w+)\s*=\s*(?:this\.)?scene\.findEntitiesByTag\s*\(\s*["']([^"']+)["']\s*\)/g
    )]; // [_, varName, tag]
    // Each setPosition's first argument (the entity ref). Strip whitespace.
    const setPosTargets = [...onUpd.matchAll(/\bsetPosition\s*\(\s*([^,)]+?)\s*,/g)].map(m => m[1]);
    for (const [, varName, tag] of tagBindings) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${varName}([^A-Za-z0-9_]|$)`);
      const isMoved = setPosTargets.some(t => re.test(t));
      if (!isMoved) continue;
      for (const e of (tagToEntities.get(tag) ?? [])) {
        if (e.type === 'kinematic' || e.type === 'dynamic' || e.type === null) continue;
        findings.push({
          template: tmpl,
          kind: 'system_moves_static_by_tag',
          entity: e.name,
          tag,
          script: sys.script,
          reason: `system "${sys.script}" reads findEntitiesByTag("${tag}") into \`${varName}\` and setPosition's it in onUpdate, but entity "${e.name}" (tagged ${tag}) is ${e.type}`,
        });
      }
    }

    // Same correlation for findEntityByName.
    const nameBindings = [...onUpd.matchAll(
      /(?:var|let|const)\s+(\w+)\s*=\s*(?:this\.)?scene\.findEntityByName\s*\(\s*["']([^"']+)["']\s*\)/g
    )];
    for (const [, varName, entName] of nameBindings) {
      const re = new RegExp(`(^|[^A-Za-z0-9_])${varName}([^A-Za-z0-9_]|$)`);
      const isMoved = setPosTargets.some(t => re.test(t));
      if (!isMoved) continue;
      const def = defs[entName];
      if (!def) continue;
      const t = physicsType(def);
      if (t === 'kinematic' || t === 'dynamic' || t === null) continue;
      findings.push({
        template: tmpl,
        kind: 'system_moves_static_by_name',
        entity: entName,
        tag: null,
        script: sys.script,
        reason: `system "${sys.script}" reads findEntityByName("${entName}") into \`${varName}\` and setPosition's it in onUpdate, but "${entName}" is ${t}`,
      });
    }
  }
  summary.push({ tmpl, count: findings.filter(f => f.template === tmpl).length });
}

// Report
const byTemplate = new Map();
for (const f of findings) {
  if (!byTemplate.has(f.template)) byTemplate.set(f.template, []);
  byTemplate.get(f.template).push(f);
}

if (findings.length === 0) {
  console.log(`Scanned ${templates.length} templates — no static-mover bugs detected.`);
  process.exit(0);
}

console.log(`Scanned ${templates.length} templates — ${findings.length} finding(s) across ${byTemplate.size} template(s):\n`);
for (const [tmpl, list] of [...byTemplate.entries()].sort()) {
  console.log(`▸ ${tmpl}`);
  for (const f of list) {
    console.log(`    [${f.kind}] ${f.reason}`);
  }
  console.log('');
}
process.exit(byTemplate.size > 0 ? 1 : 0);
