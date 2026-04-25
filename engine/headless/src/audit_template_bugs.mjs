#!/usr/bin/env node
// Static multi-check sweep across every game template. Each check matches a
// bug class we've actually hit (or one shape away from one we've hit), so
// every finding represents a real misalignment between two pieces of
// authored config — not a stylistic complaint.
//
// Checks (each one is a separate function so the report can group):
//   A.  show_ui:PATH  references that don't resolve to a UI file
//   B.  behavior / system script paths that don't resolve
//   C.  scripts referencing findEntitiesByTag("X") with no entity carrying X
//   D.  scripts referencing findEntityByName("X") with no entity matching
//   E.  dynamic bodies that the script setPosition's every frame
//        (rb.teleport zeros velocity → gravity + walking break)
//   F.  applyForce / applyImpulse / addForce / addImpulse called on the
//        owning entity when that entity is kinematic (silent no-op)
//   G.  UI HTML panels with `state.phase === '...'` literal checks that
//        don't appear as an FSM state name in the template's 01_flow.json
//   H.  FSM transitions waiting on ui_event:panel:action where the panel
//        never emits that action
//   I.  on_enter/on_exit referencing show_ui without a matching hide_ui
//        (panel pinned past its state)

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
const UI_DIR = path.join(RGC, 'ui/v0.1');

function readJSON(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }
function tryRead(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return null; } }
function exists(p) { try { return fs.existsSync(p); } catch { return false; } }

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}
function extractMethod(src, name) {
  const m = src.match(new RegExp(`${name}\\s*\\([^)]*\\)\\s*\\{`));
  if (!m) return '';
  let i = m.index + m[0].length, depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === '{') depth++; else if (c === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}

function loadScript(rel) {
  const r = (rel ?? '').replace(/^\/+/, '');
  if (!r) return null;
  return tryRead(path.join(BEHAVIORS_DIR, r)) ?? tryRead(path.join(SYSTEMS_DIR, r));
}
function scriptPathResolves(rel) {
  const r = (rel ?? '').replace(/^\/+/, '');
  if (!r) return false;
  return exists(path.join(BEHAVIORS_DIR, r)) || exists(path.join(SYSTEMS_DIR, r));
}

// Resolve a show_ui:PATH target to either a template-local override or a
// shared UI from RGC/ui/v0.1. Templates can override or add UIs by placing
// HTML files in the template dir or referenced via 01_flow.json's ui block.
function uiPathResolves(uiPath, tDir) {
  // Strip leading slashes; allow with or without "ui/" prefix and ".html"
  let p = uiPath.replace(/^\/+/, '').replace(/^ui\//, '').replace(/\.html$/, '');
  const candidates = [
    path.join(tDir, 'ui', `${p}.html`),
    path.join(tDir, `${p}.html`),
    path.join(UI_DIR, `${p}.html`),
  ];
  return candidates.some(exists);
}

const findings = [];
const push = (template, kind, reason, extra = {}) =>
  findings.push({ template, kind, reason, ...extra });

const templates = fs.readdirSync(TEMPLATES_DIR)
  .filter(d => fs.statSync(path.join(TEMPLATES_DIR, d)).isDirectory())
  .sort();

function physicsType(def) {
  if (def?.physics === false) return null;
  if (!def?.mesh) return null;
  return (def?.physics?.type || 'static').toLowerCase();
}

function* walkFlowActions(flow) {
  // Yield every show_ui / hide_ui / emit / etc. action across all states,
  // tagged with the state name and on_enter/on_exit/on_update bucket.
  const states = flow?.states ?? {};
  for (const [name, st] of Object.entries(states)) {
    for (const bucket of ['on_enter', 'on_exit', 'on_update']) {
      const list = st?.[bucket] ?? [];
      for (const a of list) yield { state: name, bucket, action: a };
    }
    for (const tr of st?.transitions ?? []) {
      for (const a of tr?.actions ?? []) yield { state: name, bucket: 'transition', action: a };
    }
  }
}

for (const tmpl of templates) {
  const tDir = path.join(TEMPLATES_DIR, tmpl);
  const ents = readJSON(path.join(tDir, '02_entities.json'));
  const flow = readJSON(path.join(tDir, '01_flow.json'));
  const sysCfg = readJSON(path.join(tDir, '04_systems.json'));
  if (!ents) continue;
  const defs = ents.definitions ?? ents;

  // ── Aggregate tags / names / behaviors / systems ──
  // Runtime entity names go through level_assembler.ts:nameFromRef:
  //   "player_car" → "Player Car"   (split on _ , Title-Case , join with space)
  // Scripts call findEntityByName with the runtime name, so we have to
  // compare against the *transformed* name, not the def key.
  const allTags = new Set();
  const allNames = new Set();         // runtime names
  const titleCase = (key) =>
    key.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  for (const [key, def] of Object.entries(defs)) {
    allNames.add(titleCase(key));
    for (const t of def?.tags ?? []) if (typeof t === 'string') allTags.add(t);
  }
  // 03_worlds.json placements may also assign explicit `name` values.
  const worlds = readJSON(path.join(tDir, '03_worlds.json'));
  for (const w of (worlds?.worlds ?? worlds ?? [])) {
    for (const p of (w?.placements ?? [])) {
      if (p?.name) allNames.add(p.name);
    }
  }
  const systemsObj = sysCfg?.systems ?? sysCfg ?? {};
  const sysList = Array.isArray(systemsObj)
    ? systemsObj
    : (systemsObj && typeof systemsObj === 'object' ? Object.values(systemsObj) : []);

  // ── Check B: behavior + system script paths resolve ──
  for (const [name, def] of Object.entries(defs)) {
    for (const beh of def?.behaviors ?? []) {
      const sp = beh.script ?? beh.path;
      if (sp && !scriptPathResolves(sp)) {
        push(tmpl, 'B_missing_script',
          `entity "${name}" behavior "${beh.name ?? sp}" references script "${sp}" — file not found in behaviors/v0.1 or systems/v0.1`);
      }
    }
  }
  for (const sys of sysList) {
    const sp = sys.script ?? sys.path;
    if (sp && !scriptPathResolves(sp)) {
      push(tmpl, 'B_missing_script',
        `system "${sys.name ?? sp}" references script "${sp}" — not found`);
    }
  }

  // ── Check A: show_ui targets resolve ──
  for (const ev of walkFlowActions(flow)) {
    const a = ev.action;
    if (typeof a !== 'string' || !a.startsWith('show_ui:')) continue;
    const ui = a.slice('show_ui:'.length).trim();
    if (!uiPathResolves(ui, tDir)) {
      push(tmpl, 'A_missing_ui',
        `flow state "${ev.state}".${ev.bucket} action "${a}" — UI "${ui}" not found in template ui/ or shared ui/v0.1`);
    }
  }

  // ── Check I: show_ui without matching hide_ui in the same state ──
  // Lets the panel leak into other states unless it's pinned via active_uis
  // (which a few templates use intentionally — skip those by checking for it
  // or for an explicit hide elsewhere).
  for (const [stateName, st] of Object.entries(flow?.states ?? {})) {
    const shows = (st.on_enter ?? []).filter(a => typeof a === 'string' && a.startsWith('show_ui:'));
    const hides = new Set((st.on_exit ?? []).filter(a => typeof a === 'string' && a.startsWith('hide_ui:'))
      .map(a => a.slice('hide_ui:'.length).trim()));
    for (const s of shows) {
      const ui = s.slice('show_ui:'.length).trim();
      if (hides.has(ui)) continue;
      // Search globally — many templates pin a HUD by show_ui in a parent
      // state and hide_ui in another. Skip if any other state hides it.
      let hiddenAnywhere = false;
      for (const ev of walkFlowActions(flow)) {
        if (ev.action === `hide_ui:${ui}`) { hiddenAnywhere = true; break; }
      }
      if (!hiddenAnywhere) {
        push(tmpl, 'I_show_no_hide',
          `flow state "${stateName}" calls show_ui:${ui} but no state ever hides it — panel will stay visible after leaving this state`);
      }
    }
  }

  // ── Check C/D/E/F: per-script analysis ──
  const scripts = []; // { src, scriptPath, ownerEntity, ownerType }
  for (const [name, def] of Object.entries(defs)) {
    const ptype = physicsType(def);
    for (const beh of def?.behaviors ?? []) {
      const src = loadScript(beh.script ?? beh.path);
      if (!src) continue;
      scripts.push({ src, scriptPath: beh.script, ownerEntity: name, ownerType: ptype, isSystem: false });
    }
  }
  for (const sys of sysList) {
    const src = loadScript(sys.script ?? sys.path);
    if (!src) continue;
    scripts.push({ src, scriptPath: sys.script, ownerEntity: null, ownerType: null, isSystem: true });
  }

  for (const s of scripts) {
    const noC = stripComments(s.src);

    // C: tag references — addTag-aware to match validate_assembler.
    for (const m of noC.matchAll(/findEntitiesByTag\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const tag = m[1];
      if (allTags.has(tag)) continue;
      // Allow tags that any script adds at runtime via addTag(_, "X").
      let runtimeTagged = false;
      for (const sx of scripts) {
        const cleanX = stripComments(sx.src);
        if (new RegExp(`\\baddTag\\s*\\([^,)]*(?:,\\s*)?["']${tag}["']`).test(cleanX)) {
          runtimeTagged = true; break;
        }
      }
      if (runtimeTagged) continue;
      push(tmpl, 'C_unknown_tag',
        `script "${s.scriptPath}" calls findEntitiesByTag("${tag}") but no entity in 02_entities.json carries that tag, and no script ever addTag's it at runtime`);
    }
    // D: name references
    for (const m of noC.matchAll(/findEntityByName\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      const n = m[1];
      // Compare case-insensitively too — engine generally case-folds, but
      // surface both flavors of mismatch.
      if (!allNames.has(n)) {
        const ci = [...allNames].find(x => x.toLowerCase() === n.toLowerCase());
        const hint = ci ? ` (case-insensitive match: "${ci}")` : '';
        push(tmpl, 'D_unknown_name',
          `script "${s.scriptPath}" calls findEntityByName("${n}") but no entity is defined with that name${hint}`);
      }
    }

    // E: dynamic body teleported every frame from its OWN behavior.
    // setPosition → rb.teleport → setLinvel(0). At 60fps this resets velocity
    // every frame so gravity / walking integration never accumulates.
    if (s.ownerType === 'dynamic' && !s.isSystem) {
      const onUpd = extractMethod(noC, 'onUpdate') || extractMethod(noC, 'onFixedUpdate');
      if (onUpd && /\bscene\.setPosition\s*\(\s*this\.entity(\.id)?\s*,/.test(onUpd)
          && !/\bscene\.(?:setVelocity|setLinearVelocity)\s*\(/.test(onUpd)) {
        // Skip when the same onUpdate ALSO drives velocity — the
        // setPosition is a targeted teleport (Z-lock, recovery), not
        // script-owned position. Real bug only when no velocity ever fires.
        push(tmpl, 'E_dynamic_teleport_loop',
          `behavior "${s.scriptPath}" on dynamic entity "${s.ownerEntity}" calls scene.setPosition(this.entity.id, ...) in onUpdate — rb.teleport zeros velocity each frame, so gravity/forces never accumulate. Use setLinearVelocity for movement, or set physics.type=kinematic if the script fully owns position.`);
      }
    }

    // F: physics-force calls on a kinematic owner (no-ops)
    if (s.ownerType === 'kinematic' && !s.isSystem) {
      const onUpd = extractMethod(noC, 'onUpdate') || extractMethod(noC, 'onFixedUpdate');
      const banned = /\b(applyForce|applyImpulse|addForce|addImpulse|applyTorque|applyTorqueImpulse)\s*\(/;
      const banned2 = /\bsetLinearVelocity\s*\(/;
      if (onUpd && banned.test(onUpd)) {
        const m = onUpd.match(banned);
        push(tmpl, 'F_force_on_kinematic',
          `behavior "${s.scriptPath}" on kinematic entity "${s.ownerEntity}" calls ${m[0].slice(0, -1)}(...) — no-op for kinematic bodies. Set physics.type=dynamic, or move the kinematic via scene.setPosition / setNextKinematicTranslation.`);
      }
      if (onUpd && banned2.test(onUpd)) {
        push(tmpl, 'F_velocity_on_kinematic',
          `behavior "${s.scriptPath}" on kinematic entity "${s.ownerEntity}" calls setLinearVelocity(...) — kinematic bodies don't integrate velocity. Drive position directly with scene.setPosition.`);
      }
    }
  }

  // ── Check G: UI panels with state.phase === literal that doesn't match an FSM state ──
  // Scan UI files referenced by show_ui actions in this template's flow.
  const flowStateNames = new Set(Object.keys(flow?.states ?? {}));
  const checkedUis = new Set();
  for (const ev of walkFlowActions(flow)) {
    const a = ev.action;
    if (typeof a !== 'string' || !a.startsWith('show_ui:')) continue;
    const ui = a.slice('show_ui:'.length).trim();
    if (checkedUis.has(ui)) continue;
    checkedUis.add(ui);
    const stripped = ui.replace(/^\/+/, '').replace(/^ui\//, '').replace(/\.html$/, '');
    const candidates = [
      path.join(tDir, 'ui', `${stripped}.html`),
      path.join(tDir, `${stripped}.html`),
      path.join(UI_DIR, `${stripped}.html`),
    ];
    const real = candidates.find(exists);
    if (!real) continue;
    const html = tryRead(real);
    if (!html) continue;
    // Look for `state.phase === 'X'` or "X" tests, plus !== variants.
    const phaseChecks = new Set();
    for (const m of html.matchAll(/state\.phase\s*===?\s*['"]([^'"]+)['"]/g)) phaseChecks.add(m[1]);
    for (const m of html.matchAll(/state\.phase\s*!==?\s*['"]([^'"]+)['"]/g)) phaseChecks.add(m[1]);
    for (const ph of phaseChecks) {
      if (!flowStateNames.has(ph) && !['playing', 'menu', 'game'].includes(ph)) {
        // 'playing'/'menu'/'game' are sometimes used as semantic categories
        // in shared UIs even when the FSM state is literally main_menu /
        // boot. Surface those separately (they're the main_menu bug shape)
        // by matching against literal state names only.
      }
      if (!flowStateNames.has(ph)) {
        push(tmpl, 'G_ui_phase_no_state',
          `ui "${stripped}.html" tests state.phase === "${ph}" but template's FSM has no state named "${ph}" (states: ${[...flowStateNames].join(', ')}). The panel branch will never fire — same shape as the main_menu === 'menu' bug.`);
      }
    }
  }

  // ── Check H: ui_event transitions waiting for actions the panel doesn't emit ──
  for (const [stateName, st] of Object.entries(flow?.states ?? {})) {
    for (const tr of st.transitions ?? []) {
      const w = tr.when;
      if (typeof w !== 'string' || !w.startsWith('ui_event:')) continue;
      const rest = w.slice('ui_event:'.length);
      const [panel, action] = rest.split(':');
      if (!panel || !action) continue;
      // Find the panel's HTML and check if it ever emits this action via
      // postMessage({type:'game_command', action: '<action>'}) — both
      // string-literal and emit("<action>") forms.
      const stripped = panel.replace(/^\/+/, '').replace(/^ui\//, '').replace(/\.html$/, '');
      const candidates = [
        path.join(tDir, 'ui', `${stripped}.html`),
        path.join(tDir, `${stripped}.html`),
        path.join(UI_DIR, `${stripped}.html`),
      ];
      const real = candidates.find(exists);
      if (!real) continue;
      const html = tryRead(real);
      if (!html) continue;
      const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re1 = new RegExp(`emit\\s*\\(\\s*['"]${escaped}['"]`);
      const re2 = new RegExp(`action:\\s*['"]${escaped}['"]`);
      if (!re1.test(html) && !re2.test(html)) {
        push(tmpl, 'H_ui_event_unemitted',
          `flow state "${stateName}" transition waits on ui_event:${panel}:${action} but ui "${stripped}.html" never emits action "${action}" — transition can't fire`);
      }
    }
  }
}

// Group + report
const byTemplate = new Map();
const byKind = new Map();
for (const f of findings) {
  if (!byTemplate.has(f.template)) byTemplate.set(f.template, []);
  byTemplate.get(f.template).push(f);
  byKind.set(f.kind, (byKind.get(f.kind) ?? 0) + 1);
}

console.log(`\n=== Multi-check template audit ===`);
console.log(`Scanned ${templates.length} templates → ${findings.length} finding(s) across ${byTemplate.size} template(s).\n`);
if (byKind.size) {
  console.log('By kind:');
  for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(28)} ${n}`);
  }
  console.log('');
}
for (const [tmpl, list] of [...byTemplate.entries()].sort()) {
  console.log(`▸ ${tmpl}  (${list.length})`);
  for (const f of list) {
    console.log(`    [${f.kind}] ${f.reason}`);
  }
  console.log('');
}
process.exit(byTemplate.size > 0 ? 1 : 0);
