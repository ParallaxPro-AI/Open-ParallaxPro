// validate_assembler_script.js — Strict assembler validation.
//
// Runs the exact same validation checks as assembleGame() in
// level_assembler.ts, entirely offline using the sandbox's project/
// directory. Replaces the HTTP-based approach that soft-failed when
// the backend was unreachable (e.g. Docker on remote workers).
//
// The 9 validation categories, checked in order (first failure exits):
//   1. Event validation — unknown game events, wrong bus, missing payload fields
//   2. Reference validation — missing behavior/system files, missing UI panels
//   3. FSM structural — missing start fields, unknown active_behaviors/systems
//   4. spawnEntity — unknown entity definition references
//   5. UI button — ui_event transitions referencing missing panel buttons
//  5b. postMessage wire-format — panel HTMLs must use type: 'game_command'
//   6. hud_update key collision — system keys shadowed by FSM reserved keys
//   7. Inline onclick IIFE — onclick attrs calling IIFE-scoped functions
//   8. Asset path validation — mesh assets, audio, textures vs asset catalogs

var fs = require('fs');
var path = require('path');

var PROJECT = 'project';
var BACKTICK = String.fromCharCode(96);

function loadJSON(filename) {
    try { return JSON.parse(fs.readFileSync(path.join(PROJECT, filename), 'utf-8')); }
    catch (e) { return null; }
}

function walkFiles(dir, ext) {
    var result = {};
    function walk(d, prefix) {
        if (!fs.existsSync(d)) return;
        var entries = fs.readdirSync(d, { withFileTypes: true });
        for (var i = 0; i < entries.length; i++) {
            var entry = entries[i];
            var full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full, prefix + entry.name + '/');
            else if (entry.name.endsWith(ext)) {
                try { result[prefix + entry.name] = fs.readFileSync(full, 'utf-8'); } catch (e) {}
            }
        }
    }
    walk(dir, '');
    return result;
}

function scriptExists(scriptPath) {
    var rel = scriptPath.replace(/^\/+/, '');
    return fs.existsSync(path.join(PROJECT, 'behaviors', rel)) ||
           fs.existsSync(path.join(PROJECT, 'systems', rel));
}

// ─── Load data ───────────────────────────────────────────────────────

var flow = loadJSON('01_flow.json');
var entityDefs = loadJSON('02_entities.json');
var systemsDef = loadJSON('04_systems.json');

var defs = (entityDefs && entityDefs.definitions) || {};
var systems = Object.assign({}, (systemsDef && systemsDef.systems) || {});
if (!systems['ui']) systems['ui'] = { script: 'ui/ui_bridge.ts' };
var mpEnabled = !!(flow && flow.multiplayer && flow.multiplayer.enabled !== false);
if (mpEnabled && !systems['mp_bridge']) systems['mp_bridge'] = { script: 'mp/mp_bridge.ts' };

// Read all project scripts
var allScripts = {};
['behaviors', 'systems', 'scripts'].forEach(function(dir) {
    var scripts = walkFiles(path.join(PROJECT, dir), '.ts');
    var keys = Object.keys(scripts);
    for (var i = 0; i < keys.length; i++) {
        allScripts[dir + '/' + keys[i]] = scripts[keys[i]];
    }
});

// Read UI files (keyed as ui/path/file.html to match assembler convention)
var rawUI = walkFiles(path.join(PROJECT, 'ui'), '.html');
var uiFiles = {};
var rawUIKeys = Object.keys(rawUI);
for (var i = 0; i < rawUIKeys.length; i++) {
    uiFiles['ui/' + rawUIKeys[i]] = rawUI[rawUIKeys[i]];
}

// Normalize flow UI actions — strip .html from show_ui:/hide_ui:
function normalizeFlowUIActions(states) {
    if (!states) return;
    var stateVals = Object.values(states);
    for (var si = 0; si < stateVals.length; si++) {
        var state = stateVals[si];
        var actionKeys = ['on_enter', 'on_exit', 'on_update', 'on_timeout'];
        for (var ki = 0; ki < actionKeys.length; ki++) {
            var list = state[actionKeys[ki]];
            if (!Array.isArray(list)) continue;
            for (var li = 0; li < list.length; li++) {
                if (typeof list[li] !== 'string') continue;
                var verbs = ['show_ui:', 'hide_ui:'];
                for (var vi = 0; vi < verbs.length; vi++) {
                    if (list[li].startsWith(verbs[vi]) && list[li].endsWith('.html')) {
                        list[li] = list[li].slice(0, -5);
                        break;
                    }
                }
            }
        }
        if (state.substates) normalizeFlowUIActions(state.substates);
    }
}
if (flow && flow.states) normalizeFlowUIActions(flow.states);

// ─── Parse event definitions ─────────────────────────────────────────

function parseEventDefs() {
    var evtPath = path.join(PROJECT, 'systems', 'event_definitions.ts');
    if (!fs.existsSync(evtPath)) return null;
    var evtSrc = fs.readFileSync(evtPath, 'utf-8');
    var names = new Set();
    var nameMatches = evtSrc.matchAll(/^\s+(\w+)\s*:\s*\{/gm);
    for (var m of nameMatches) names.add(m[1]);
    var nonEvents = ['fields', 'type', 'optional'];
    for (var ni = 0; ni < nonEvents.length; ni++) names.delete(nonEvents[ni]);
    if (names.size === 0) return null;

    var eventDefs = {};
    for (var name of names) {
        var re = new RegExp(name + '\\s*:\\s*\\{\\s*fields\\s*:\\s*\\{([^}]*)\\}', 's');
        var fieldMatch = evtSrc.match(re);
        var fields = {};
        if (fieldMatch && fieldMatch[1].trim()) {
            var fieldEntries = fieldMatch[1].matchAll(/(\w+)\s*:\s*\{([^}]*)\}/g);
            for (var fe of fieldEntries) {
                var typeMatch = fe[2].match(/type\s*:\s*'(\w+)'/);
                var optMatch = fe[2].match(/optional\s*:\s*true/);
                fields[fe[1]] = { type: typeMatch ? typeMatch[1] : 'any', optional: !!optMatch };
            }
        }
        eventDefs[name] = { fields: fields };
    }
    return { names: names, defs: eventDefs };
}


// ═════════════════════════════════════════════════════════════════════
// 1. Event validation
// ═════════════════════════════════════════════════════════════════════
var eventData = parseEventDefs();
if (eventData) {
    var validEvents = eventData.names;
    var evtDefs = eventData.defs;
    var eventErrors = [];
    var gameEventsEmitted = new Set();

    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];

        // Check event names are valid
        for (var m of source.matchAll(/events\.game\.(?:on|emit)\s*\(\s*"([^"]+)"/g)) {
            if (!validEvents.has(m[1])) {
                eventErrors.push(scriptKey + ': unknown game event "' + m[1] + '"');
            }
        }
        // Collect emitted events
        for (var m of source.matchAll(/events\.game\.emit\s*\(\s*"([^"]+)"/g)) {
            gameEventsEmitted.add(m[1]);
        }
        // Check game events wrongly on ui bus
        for (var m of source.matchAll(/events\.ui\.emit\s*\(\s*"([^"]+)"/g)) {
            if (validEvents.has(m[1])) {
                eventErrors.push(scriptKey + ': game event "' + m[1] + '" emitted on ui bus \u2014 should use events.game.emit');
            }
        }
        // Validate emit payloads \u2014 check required fields are present
        for (var m of source.matchAll(/events\.game\.emit\s*\(\s*"([^"]+)"\s*,\s*(\{[^}]*\})/g)) {
            var evtName = m[1];
            var payloadStr = m[2];
            var def = evtDefs[evtName];
            if (!def) continue;
            var fieldEntries2 = Object.entries(def.fields);
            for (var fi = 0; fi < fieldEntries2.length; fi++) {
                var fieldName = fieldEntries2[fi][0];
                var fieldDef = fieldEntries2[fi][1];
                if (!fieldDef.optional && payloadStr.indexOf(fieldName) < 0) {
                    eventErrors.push(scriptKey + ': emit("' + evtName + '") missing required field "' + fieldName + '"');
                }
            }
        }
    }

    // Validate flow emit actions + collect emitted events
    function validateFlowActions(states, prefix) {
        if (!states) return;
        var entries = Object.entries(states);
        for (var i = 0; i < entries.length; i++) {
            var stateName = entries[i][0];
            var state = entries[i][1];
            var actionLists = [state.on_enter, state.on_exit, state.on_update, state.on_timeout];
            for (var ai = 0; ai < actionLists.length; ai++) {
                var actionList = actionLists[ai];
                if (!Array.isArray(actionList)) continue;
                for (var j = 0; j < actionList.length; j++) {
                    var action = actionList[j];
                    if (typeof action === 'string' && action.startsWith('emit:game.')) {
                        var eventName = action.substring('emit:game.'.length);
                        if (!validEvents.has(eventName)) {
                            eventErrors.push('01_flow.json ' + prefix + stateName + ': unknown game event "' + eventName + '"');
                        }
                        gameEventsEmitted.add(eventName);
                    }
                }
            }
            if (state.substates) validateFlowActions(state.substates, prefix + stateName + '/');
        }
    }
    if (flow && flow.states) validateFlowActions(flow.states, '');

    // Add FSM driver built-in emits
    try {
        var fsmSrc = fs.readFileSync(path.join(PROJECT, 'systems', 'fsm_driver.ts'), 'utf-8');
        for (var m of fsmSrc.matchAll(/_emitBus\s*\(\s*"game"\s*,\s*"([^"]+)"/g)) {
            gameEventsEmitted.add(m[1]);
        }
    } catch (e) {}

    // Validate flow transition event references
    function validateTransitions(states, prefix) {
        if (!states) return;
        var entries = Object.entries(states);
        for (var i = 0; i < entries.length; i++) {
            var stateName = entries[i][0];
            var state = entries[i][1];
            var transitions = state.transitions || [];
            for (var ti = 0; ti < transitions.length; ti++) {
                var when = transitions[ti].when || '';
                if (!when || /[>=<!]/.test(when)) continue;
                if (when === 'timer_expired' || when === 'random' || when.startsWith('random:')) continue;

                if (when.startsWith('game_event:')) {
                    var en = when.substring('game_event:'.length);
                    if (!validEvents.has(en)) {
                        eventErrors.push('01_flow.json ' + prefix + stateName + ': unknown game event "' + en + '" in "' + when + '"');
                    }
                } else if (when.startsWith('ui_event:') || when.startsWith('keyboard:') || when.includes('.')) {
                    // Validated separately or bus.event format
                } else if (!when.includes(':')) {
                    eventErrors.push('01_flow.json ' + prefix + stateName + ': bare event name "' + when + '" \u2014 use game_event:' + when + ', ui_event:panel:action, or keyboard:action');
                }
            }
            if (state.substates) validateTransitions(state.substates, prefix + stateName + '/');
        }
    }
    if (flow && flow.states) validateTransitions(flow.states, '');

    if (eventErrors.length > 0) {
        console.error('Event validation failed: ' + eventErrors.length + ' invalid event name(s). ' + eventErrors[0]);
        process.exit(1);
    }
}


// ═════════════════════════════════════════════════════════════════════
// 2. Reference validation — missing scripts + missing UI panels
// ═════════════════════════════════════════════════════════════════════
(function() {
    var refErrors = [];

    // Check behavior scripts referenced in entity definitions (recurse
    // into children — the assembler's buildEntity does the same).
    function checkDefBehaviors(def) {
        if (def && def.behaviors) {
            for (var bi = 0; bi < def.behaviors.length; bi++) {
                var beh = def.behaviors[bi];
                if (beh && beh.script && !scriptExists(beh.script)) {
                    refErrors.push('missing behavior/system file: ' + beh.script);
                }
            }
        }
        if (def && def.children) {
            for (var ci = 0; ci < def.children.length; ci++) {
                checkDefBehaviors(def.children[ci]);
            }
        }
    }
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        checkDefBehaviors(defs[defKeys[di]]);
    }

    // Check system scripts referenced in 04_systems.json
    var sysEntries = Object.entries(systems);
    for (var si = 0; si < sysEntries.length; si++) {
        var sys = sysEntries[si][1];
        if (sys && sys.script && !scriptExists(sys.script)) {
            refErrors.push('missing behavior/system file: ' + sys.script);
        }
    }

    // Check UI panel references in flow actions (show_ui:/hide_ui:)
    var uiPanelKeys = new Set(Object.keys(uiFiles));
    function validateUIRefs(states, prefix) {
        if (!states) return;
        var entries = Object.entries(states);
        for (var i = 0; i < entries.length; i++) {
            var stateName = entries[i][0];
            var state = entries[i][1];
            var actionLists = [state.on_enter, state.on_exit, state.on_update, state.on_timeout];
            for (var ai = 0; ai < actionLists.length; ai++) {
                if (!Array.isArray(actionLists[ai])) continue;
                for (var j = 0; j < actionLists[ai].length; j++) {
                    var action = actionLists[ai][j];
                    if (typeof action !== 'string') continue;
                    var panel = null;
                    if (action.startsWith('show_ui:')) panel = action.substring('show_ui:'.length);
                    else if (action.startsWith('hide_ui:')) panel = action.substring('hide_ui:'.length);
                    if (panel && !uiPanelKeys.has('ui/' + panel + '.html')) {
                        refErrors.push('01_flow.json ' + prefix + stateName + ': missing UI panel "' + panel + '" (expected ui/' + panel + '.html)');
                    }
                }
            }
            if (state.substates) validateUIRefs(state.substates, prefix + stateName + '/');
        }
    }
    if (flow && flow.states) validateUIRefs(flow.states, '');

    if (refErrors.length > 0) {
        console.error('Reference validation failed: ' + refErrors.length + ' missing reference(s). ' + refErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 3. FSM structural validation
// ═════════════════════════════════════════════════════════════════════
(function() {
    var validBehaviorNames = new Set();
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var defVal = defs[defKeys[di]];
        if (defVal && defVal.behaviors) {
            for (var bi = 0; bi < defVal.behaviors.length; bi++) {
                var b = defVal.behaviors[bi];
                if (b && b.name) validBehaviorNames.add(String(b.name));
            }
        }
    }
    var validSystemNames = new Set(Object.keys(systems));

    var structuralErrors = [];

    if (flow && flow.states) {
        if (!flow.start) {
            structuralErrors.push(
                '01_flow.json: missing required top-level "start" field \u2014 every flow needs an initial state name (e.g. "start": "boot").'
            );
        }

        function walkFSM(states, prefix) {
            var entries = Object.entries(states);
            for (var i = 0; i < entries.length; i++) {
                var name = entries[i][0];
                var st = entries[i][1];
                var p = prefix ? prefix + '.' + name : name;
                if (st && st.substates && !st.start) {
                    structuralErrors.push(
                        '01_flow.json state "' + p + '" is compound (has substates) but missing "start".'
                    );
                }
                if (st && Array.isArray(st.active_behaviors)) {
                    for (var bi = 0; bi < st.active_behaviors.length; bi++) {
                        var bName = String(st.active_behaviors[bi]);
                        if (!validBehaviorNames.has(bName)) {
                            var valid = Array.from(validBehaviorNames).sort().join(', ') || '(none declared)';
                            structuralErrors.push(
                                '01_flow.json state "' + p + '" active_behaviors references unknown behavior "' + bName + '". Valid names: ' + valid
                            );
                        }
                    }
                }
                if (st && Array.isArray(st.active_systems)) {
                    for (var si = 0; si < st.active_systems.length; si++) {
                        var sName = String(st.active_systems[si]);
                        if (!validSystemNames.has(sName)) {
                            var valid = Array.from(validSystemNames).sort().join(', ');
                            structuralErrors.push(
                                '01_flow.json state "' + p + '" active_systems references unknown system "' + sName + '". Valid names: ' + valid
                            );
                        }
                    }
                }
                if (st && st.substates) walkFSM(st.substates, p);
            }
        }
        walkFSM(flow.states, '');
    }

    if (structuralErrors.length > 0) {
        console.error('FSM structural validation failed: ' + structuralErrors.length + ' error(s). ' + structuralErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 4. spawnEntity validation
// ═════════════════════════════════════════════════════════════════════
//
// Catches the tower_siege / armor_assault class of bug: scripts call
// spawnEntity but the entity name comes from a hardcoded data table
// (e.g. _enemyDefs.light.entity = "enemy_tank_light", _waveData = [{
// type: "enemy_goblin" }]) — and that name is missing from the
// template's 02_entities.json. The literal-arg check misses these
// because the spawnEntity call site looks like spawnEntity(def.entity)
// or spawnEntity(type) with a variable.
//
// Four patterns checked, only inside scripts that actually call
// .spawnEntity(:
//   a. .spawnEntity("X")               — direct literal arg
//   b. entity: "X" / type: "X" / etc.  — data-table field values that
//                                        flow into spawnEntity
//   c. _*Stats = { X: { ... } }        — stat-table object keys that
//                                        double as entity names
//   d. _spawn("X", ...)                — wrapper method that ultimately
//                                        calls spawnEntity (the
//                                        street_surfer regression).
// Heuristic guard for (b)+(c)+(d): only flag values that look like
// snake_case entity keys (contain an underscore) OR are 4+ chars all
// lowercase. Filters out generic values like "shot", "ammo",
// "rotation" which use the same field name conventions but aren't
// entity references.
(function() {
    var validPrefabs = new Set(Object.keys(defs));
    var spawnErrors = [];
    var scriptEntries = Object.entries(allScripts);

    var TABLE_FIELD_RE = /(?:entity|type|spawnRef|entityType|enemyType)\s*:\s*['"]([a-z][A-Za-z0-9_]*)['"]/g;
    var STATS_BLOCK_RE = /_(?:enemy|unit|monster|spawn|wave|tower|ally|boss)\w*Stats\s*=\s*\{([^}]+)\}/gi;
    var STATS_KEY_RE = /^\s*([a-z][a-z0-9_]*)\s*:\s*\{/gm;
    var ENTITY_KEY_RE = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
    function looksLikeEntityKey(s) { return ENTITY_KEY_RE.test(s); }

    function flag(scriptKey, name, kind) {
        if (validPrefabs.has(name)) return;
        var valid = Array.from(validPrefabs).sort().join(', ') || '(none)';
        spawnErrors.push(
            scriptKey + ': [' + kind + '] "' + name + '" — references unknown entity definition. Valid names: ' + valid
        );
    }

    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];

        // Skip files that don't call spawnEntity. createEntity is the
        // bare-entity API and accepts arbitrary names by design.
        if (!/\.spawnEntity\s*\(/.test(source)) continue;

        // (a) direct literal args
        var seen = new Set();
        for (var m of source.matchAll(/\.spawnEntity\s*\(\s*['"]([^'"]+)['"]/g)) {
            if (!seen.has('a:' + m[1])) { seen.add('a:' + m[1]); flag(scriptKey, m[1], 'spawnEntity literal'); }
        }
        // (b) data-table field values
        for (var tm of source.matchAll(TABLE_FIELD_RE)) {
            var v = tm[1];
            if (!looksLikeEntityKey(v)) continue;
            if (!seen.has('b:' + v)) { seen.add('b:' + v); flag(scriptKey, v, 'data-table entity ref'); }
        }
        // (c) _*Stats object-literal keys
        for (var bm of source.matchAll(STATS_BLOCK_RE)) {
            var block = bm[1];
            for (var km of block.matchAll(STATS_KEY_RE)) {
                var k = km[1];
                if (!looksLikeEntityKey(k)) continue;
                if (!seen.has('c:' + k)) { seen.add('c:' + k); flag(scriptKey, k, '_*Stats key'); }
            }
        }
        // (d) _spawn("X", ...) — wrapper-method literal calls. Many
        // engines wrap spawnEntity in a helper that adds bookkeeping
        // (street_surfer's surf_spawner._spawn pushes to an internal
        // list). The literal-arg check at (a) misses these. We only
        // run this in files that ALSO call .spawnEntity(, so we don't
        // false-flag unrelated `_spawn` helpers in other contexts.
        for (var dm of source.matchAll(/\b_spawn\s*\(\s*['"]([^'"]+)['"]/g)) {
            var dv = dm[1];
            if (!seen.has('d:' + dv)) { seen.add('d:' + dv); flag(scriptKey, dv, '_spawn wrapper literal'); }
        }
    }
    if (spawnErrors.length > 0) {
        console.error('spawnEntity validation failed: ' + spawnErrors.length + ' error(s). ' + spawnErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 5. UI button validation
// ═════════════════════════════════════════════════════════════════════
(function() {
    var panelButtons = new Map();
    var uiEntries = Object.entries(uiFiles);
    for (var ui = 0; ui < uiEntries.length; ui++) {
        var uiPath = uiEntries[ui][0];
        var html = uiEntries[ui][1];
        var panelName = uiPath.replace('ui/', '').replace('.html', '');
        var buttons = new Set();
        for (var m of html.matchAll(/emit\s*\(\s*['"]([^'"]+)['"]/g)) buttons.add(m[1]);
        if (buttons.size > 0) panelButtons.set(panelName, buttons);
    }

    var uiErrors = [];
    function validateUIButtons(states, prefix) {
        if (!states) return;
        var entries = Object.entries(states);
        for (var i = 0; i < entries.length; i++) {
            var stateName = entries[i][0];
            var state = entries[i][1];
            var transitions = state.transitions || [];
            for (var ti = 0; ti < transitions.length; ti++) {
                var when = transitions[ti].when || '';
                if (!when.startsWith('ui_event:')) continue;
                var parts = when.substring('ui_event:'.length).split(':');
                if (parts.length !== 2) {
                    uiErrors.push(prefix + stateName + ': malformed ui_event "' + when + '" (expected ui_event:panel:action)');
                    continue;
                }
                var panel = parts[0], action = parts[1];
                var buttons = panelButtons.get(panel);
                if (!buttons) {
                    uiErrors.push(prefix + stateName + ': ui_event references panel "' + panel + '" but no buttons found in ' + panel + '.html');
                } else if (!buttons.has(action)) {
                    uiErrors.push(prefix + stateName + ': ui_event references button "' + action + '" but ' + panel + '.html only has: ' + Array.from(buttons).join(', '));
                }
            }
            if (state.substates) validateUIButtons(state.substates, prefix + stateName + '/');
        }
    }
    if (flow && flow.states) validateUIButtons(flow.states, '');

    if (uiErrors.length > 0) {
        console.error('UI button validation failed: ' + uiErrors.length + ' error(s). ' + uiErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 5b. postMessage wire-format validation
// ═════════════════════════════════════════════════════════════════════
// The engine's html_ui_manager only handles messages with
// `type: 'game_command'` — any other type is silently dropped and the
// click does nothing, with no validate.sh failure and no runtime error.
// Catch the drift here so a typo (or a re-written doc) can't ship a
// game with every button dead.
(function() {
    var errs = [];
    var entries = Object.entries(uiFiles);
    for (var i = 0; i < entries.length; i++) {
        var uiPath = entries[i][0];
        var html = entries[i][1];
        var panelName = uiPath.replace('ui/', '').replace('.html', '');
        // Match `postMessage(` and capture the first-arg object literal.
        // Lazy `{[\s\S]*?}` is fine — panel payloads are a handful of
        // fields and don't contain nested objects in practice.
        var re = /postMessage\s*\(\s*(\{[\s\S]*?\})/g;
        var m;
        while ((m = re.exec(html)) !== null) {
            var obj = m[1];
            var typeMatch = obj.match(/type\s*:\s*['"]([^'"]+)['"]/);
            if (typeMatch && typeMatch[1] !== 'game_command') {
                errs.push(
                    panelName + '.html: postMessage uses type "' + typeMatch[1] + '" — the engine only routes type: "game_command". ' +
                    'Every button in this panel is silently dead. Change the type literal to \'game_command\'.'
                );
            }
        }
    }
    if (errs.length > 0) {
        console.error('UI postMessage validation failed: ' + errs.length + ' error(s). ' + errs[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 6. hud_update key collision validation
// ═════════════════════════════════════════════════════════════════════
(function() {
    var reservedKeys = new Set(['phase']);

    function collectSetVars(states) {
        if (!states) return;
        var stateVals = Object.values(states);
        for (var si = 0; si < stateVals.length; si++) {
            var state = stateVals[si];
            var actions = [].concat(
                state.on_enter || [],
                state.on_exit || [],
                state.on_update || [],
                (state.transitions || []).reduce(function(a, t) { return a.concat(t.actions || []); }, [])
            );
            for (var ai = 0; ai < actions.length; ai++) {
                var m = String(actions[ai]).match(/^set:([A-Za-z_]\w*)\s*=/);
                if (m) reservedKeys.add(m[1]);
            }
            if (state.substates) collectSetVars(state.substates);
        }
    }
    if (flow && flow.states) collectSetVars(flow.states);

    // Walk the top level of a JS object literal and return key identifiers.
    function topLevelKeys(literal) {
        var body = literal.slice(1, -1);
        var out = [];
        var depth = 0, i = 0;
        var inStr = false, strCh = '';
        var inLine = false, inBlock = false;
        while (i < body.length) {
            var c = body[i], n = body[i + 1];
            if (inLine) { if (c === '\n') inLine = false; i++; continue; }
            if (inBlock) { if (c === '*' && n === '/') { inBlock = false; i += 2; continue; } i++; continue; }
            if (inStr) {
                if (c === '\\') { i += 2; continue; }
                if (c === strCh) inStr = false;
                i++; continue;
            }
            if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
            if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
            if (c === '"' || c === "'" || c === BACKTICK) { inStr = true; strCh = c; i++; continue; }
            if (c === '{' || c === '[' || c === '(') { depth++; i++; continue; }
            if (c === '}' || c === ']' || c === ')') { depth--; i++; continue; }
            if (depth === 0) {
                var m = body.slice(i).match(/^(?:['"]([A-Za-z_$][\w$]*)['"]|([A-Za-z_$][\w$]*))\s*:/);
                if (m) { out.push(m[1] || m[2]); i += m[0].length; continue; }
            }
            i++;
        }
        return out;
    }

    var hudErrors = [];
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];
        var re = /events\.ui\.emit\s*\(\s*['"]hud_update['"]\s*,\s*\{/g;
        var match;
        while ((match = re.exec(source)) !== null) {
            var openIdx = match.index + match[0].length - 1;
            var depth = 0, end = -1;
            for (var i = openIdx; i < source.length; i++) {
                if (source[i] === '{') depth++;
                else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
            }
            if (end < 0) continue;
            var literal = source.slice(openIdx, end + 1);
            var keys = topLevelKeys(literal);
            for (var ki = 0; ki < keys.length; ki++) {
                if (reservedKeys.has(keys[ki])) {
                    var keyName = keys[ki];
                    var fix = keyName === 'phase'
                        ? 'Rename the HUD-side key (the engine reserves "phase" for the FSM\'s current state name).'
                        : 'Rename the HUD-side key (e.g. "display' + keyName.charAt(0).toUpperCase() + keyName.slice(1) +
                          '" or "' + keyName + '_display") OR rename the FSM var in 01_flow.json. ' +
                          'They live in different namespaces but share the lookup table — the FSM var ' +
                          'shadows your HUD value and the panel never sees your update.';
                    hudErrors.push(
                        scriptKey + ': hud_update key "' + keyName + '" collides with FSM var "' + keyName + '" ' +
                        '(set in 01_flow.json via set:' + keyName + '=...). ' + fix
                    );
                }
            }
        }
    }
    if (hudErrors.length > 0) {
        console.error('hud_update key validation failed: ' + hudErrors.length + ' error(s). ' + hudErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 7. Inline onclick IIFE validation
// ═════════════════════════════════════════════════════════════════════
(function() {
    var onclickErrors = [];
    var uiEntries = Object.entries(uiFiles);
    for (var ui = 0; ui < uiEntries.length; ui++) {
        var uiPath = uiEntries[ui][0];
        var html = uiEntries[ui][1];

        var scriptBlocks = [];
        for (var m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) scriptBlocks.push(m[1]);

        var isIIFE = function(s) {
            return /^\s*(?:\/\/[^\n]*\n|\/\*[\s\S]*?\*\/|\s)*(?:\(\s*(?:function\b|\(\s*\)\s*=>)|!function\b)/.test(s);
        };
        if (!scriptBlocks.some(isIIFE)) continue;

        // Names exposed to window
        var exposed = new Set();
        for (var si = 0; si < scriptBlocks.length; si++) {
            for (var m of scriptBlocks[si].matchAll(/\bwindow\.([A-Za-z_$][\w$]*)\s*=/g)) exposed.add(m[1]);
        }
        // Names defined at top level in non-IIFE sibling scripts
        for (var si = 0; si < scriptBlocks.length; si++) {
            if (isIIFE(scriptBlocks[si])) continue;
            for (var m of scriptBlocks[si].matchAll(/(?:^|\n)\s*(?:function\s+|var\s+|let\s+|const\s+)([A-Za-z_$][\w$]*)\b/g)) exposed.add(m[1]);
        }

        // onclick handler names
        var onclickNames = new Set();
        for (var m of html.matchAll(/onclick\s*=\s*["']\s*([A-Za-z_$][\w$]*)\s*\(/gi)) onclickNames.add(m[1]);

        for (var name of onclickNames) {
            if (exposed.has(name)) continue;
            onclickErrors.push(
                uiPath + ': onclick="' + name + '(...)" references a function that is not exposed on window.'
            );
        }
    }
    if (onclickErrors.length > 0) {
        console.error('Inline-onclick IIFE validation failed: ' + onclickErrors.length + ' error(s). ' + onclickErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 8. Asset path validation — mesh assets, audio, textures
// ═════════════════════════════════════════════════════════════════════
// Parse the asset catalogs (assets/3D_MODELS.md, assets/AUDIO.md,
// assets/TEXTURES.md) that the sandbox seeder generates from the real
// asset directory. Every path in an entity def's mesh.asset, a
// script's playSound/playMusic, OR a flow `play_sound:` action must
// appear in the catalog, otherwise the runtime will silently fail
// (invisible meshes, no audio).
(function() {
    function parseCatalog(filename) {
        var catalogPath = path.join('assets', filename);
        if (!fs.existsSync(catalogPath)) return new Set();
        var lines = fs.readFileSync(catalogPath, 'utf-8').split('\n');
        var paths = new Set();
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (line.startsWith('- /assets/')) {
                paths.add(line.substring(2));
            }
        }
        return paths;
    }

    var modelPaths = parseCatalog('3D_MODELS.md');
    var audioPaths = parseCatalog('AUDIO.md');
    var texturePaths = parseCatalog('TEXTURES.md');
    var allAssets = new Set([...modelPaths, ...audioPaths, ...texturePaths]);

    // Skip if no catalogs found (offline/self-hosted dev without assets).
    // `return` (not process.exit) so subsequent checks below still run.
    if (allAssets.size === 0) return;

    var assetErrors = [];

    // Check mesh.asset in entity definitions (recurse into children)
    function checkDefAssets(def, defName) {
        if (def && def.mesh && def.mesh.asset) {
            var asset = def.mesh.asset;
            if (audioPaths.has(asset) || texturePaths.has(asset)) {
                assetErrors.push(
                    '02_entities.json "' + defName + '": mesh asset "' + asset + '" is not a 3D model. ' +
                    'mesh.asset must be a .glb file from assets/3D_MODELS.md, not an audio or texture file.'
                );
            } else if (!modelPaths.has(asset)) {
                assetErrors.push(
                    '02_entities.json "' + defName + '": mesh asset "' + asset + '" not found in asset catalog. ' +
                    'Check assets/3D_MODELS.md for available models.'
                );
            }
        }
        if (def && def.mesh_override && def.mesh_override.textureBundle) {
            var tex = def.mesh_override.textureBundle;
            if (modelPaths.has(tex) || audioPaths.has(tex)) {
                assetErrors.push(
                    '02_entities.json "' + defName + '": textureBundle "' + tex + '" is not a texture. ' +
                    'textureBundle must be a .png/.jpg file from assets/TEXTURES.md, not a model or audio file.'
                );
            } else if (!texturePaths.has(tex)) {
                assetErrors.push(
                    '02_entities.json "' + defName + '": textureBundle "' + tex + '" not found in asset catalog. ' +
                    'Check assets/TEXTURES.md for available textures.'
                );
            }
        }
        if (def && def.children) {
            for (var ci = 0; ci < def.children.length; ci++) {
                checkDefAssets(def.children[ci], defName + '/' + (def.children[ci].name || 'child'));
            }
        }
    }
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        checkDefAssets(defs[defKeys[di]], defKeys[di]);
    }

    // Check audio references in scripts: playSound("/assets/...") and playMusic("/assets/...")
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];
        for (var m of source.matchAll(/\.(?:playSound|playMusic|preload)\s*\(\s*["']([^"']+)["']/g)) {
            var audioPath = m[1];
            if (!audioPath.startsWith('/assets/')) continue;
            if (modelPaths.has(audioPath) || texturePaths.has(audioPath)) {
                assetErrors.push(
                    scriptKey + ': playSound/playMusic("' + audioPath + '") is not an audio file. ' +
                    'Audio calls must use .ogg/.mp3/.wav files from assets/AUDIO.md, not a model or texture.'
                );
            } else if (!audioPaths.has(audioPath)) {
                assetErrors.push(
                    scriptKey + ': audio asset "' + audioPath + '" not found in asset catalog. ' +
                    'Check assets/AUDIO.md for available audio files.'
                );
            }
        }
    }

    // Check audio references in flow file: `play_sound:/assets/...` action
    // strings inside on_enter / on_exit / on_update / transition.actions.
    // Without this, a typo like "interface_sounds/pepSound1.ogg" (real file
    // is in digital_audio/) or "voiceover_pack/go.ogg" (real file is in the
    // male/ or female/ subfolder) would silently fail at runtime — the
    // racing/soccer/stumble_dash/tower_siege regression class.
    if (flow) {
        var flowText = JSON.stringify(flow);
        for (var fm of flowText.matchAll(/play_sound:(\/assets\/[^"' ,]+)/g)) {
            var fa = fm[1];
            if (modelPaths.has(fa) || texturePaths.has(fa)) {
                assetErrors.push(
                    '01_flow.json: play_sound:"' + fa + '" is not an audio file. ' +
                    'Audio actions must use .ogg/.mp3/.wav files from assets/AUDIO.md.'
                );
            } else if (!audioPaths.has(fa)) {
                assetErrors.push(
                    '01_flow.json: play_sound:"' + fa + '" not found in asset catalog. ' +
                    'Check assets/AUDIO.md for available audio files.'
                );
            }
        }
    }

    if (assetErrors.length > 0) {
        console.error('Asset validation failed: ' + assetErrors.length + ' missing asset(s). ' + assetErrors[0]);
        process.exit(1);
    }
})();


// (No mesh-override validation — `mesh.scale` and `mesh.modelRotation*` on
// custom meshes are still supported by the engine for legacy projects and
// edge cases. The 40 templates demonstrate the new convention by example
// instead of the validator enforcing it.)


// ═════════════════════════════════════════════════════════════════════
// 9. Tag lookups resolve
// ═════════════════════════════════════════════════════════════════════
// findEntitiesByTag("X") that returns [] is invisible at runtime — combat
// targets nothing, AI patrols nothing, the system silently does nothing.
// This shape broke combat across rts_battle (tag "enemy" / "military"
// queried, no entity carried either), mmorpg (tag "hostile"),
// sandbox_survival + voxel_survival ("hostile"), pipe_runner ("powerup",
// "spawned_mushroom"), multiplayer_zone_royale ("royale_loot"),
// multiplayer_neon_cycles ("trail").
//
// Spawn-aware: a tag counts as "known" if (a) some entity in
// 02_entities.json carries it, OR (b) any script ever calls addTag(_,"X")
// (runtime-added), OR (c) a script spawnEntity's a prefab whose def
// carries that tag.
function stripCommentsForScan(src) {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:\\])\/\/.*$/gm, '$1');
}
(function checkTagLookups() {
    var knownTags = new Set();
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var tagsArr = defs[defKeys[di]].tags || [];
        for (var ti = 0; ti < tagsArr.length; ti++) {
            if (typeof tagsArr[ti] === 'string') knownTags.add(tagsArr[ti]);
        }
    }
    // Walk all scripts for addTag(...) calls — any literal string arg gets
    // added to the known set. Match both addTag(id, "X") and entity.addTag("X").
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var src = stripCommentsForScan(scriptEntries[sei][1]);
        for (var m of src.matchAll(/\baddTag\s*\([^,)]*(?:,\s*)?["']([^"']+)["']/g)) {
            knownTags.add(m[1]);
        }
    }
    // Same for tags carried by any spawnEntity("name") target (the spawned
    // prefab inherits its def's tags). Include tags from the def even if no
    // placement of that prefab exists in 03_worlds.json.
    for (var sei2 = 0; sei2 < scriptEntries.length; sei2++) {
        var src2 = stripCommentsForScan(scriptEntries[sei2][1]);
        for (var sm of src2.matchAll(/\bspawnEntity\s*\(\s*["']([^"']+)["']/g)) {
            var prefab = defs[sm[1]];
            if (!prefab || !prefab.tags) continue;
            for (var pti = 0; pti < prefab.tags.length; pti++) {
                if (typeof prefab.tags[pti] === 'string') knownTags.add(prefab.tags[pti]);
            }
        }
    }

    var tagErrors = [];
    var seen = new Set();
    for (var sei3 = 0; sei3 < scriptEntries.length; sei3++) {
        var scriptKey = scriptEntries[sei3][0];
        var srcRaw = scriptEntries[sei3][1];
        var src3 = stripCommentsForScan(srcRaw);
        for (var tm of src3.matchAll(/\bfindEntitiesByTag\s*\(\s*["']([^"']+)["']\s*\)/g)) {
            var tag = tm[1];
            if (knownTags.has(tag)) continue;
            var key = scriptKey + '|' + tag;
            if (seen.has(key)) continue;
            seen.add(key);
            tagErrors.push(
                scriptKey + ': findEntitiesByTag("' + tag + '") will always return [] — ' +
                'no entity in 02_entities.json carries tag "' + tag + '", no script calls addTag(_, "' + tag + '"), ' +
                'and no spawnEntity target prefab carries it. Either tag the relevant entities, addTag at runtime, ' +
                'or fix the literal in this lookup.'
            );
        }
    }
    if (tagErrors.length > 0) {
        console.error('Tag-lookup validation failed: ' + tagErrors.length + ' broken lookup(s). ' + tagErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 10. Name lookups resolve
// ═════════════════════════════════════════════════════════════════════
// findEntityByName("X") that returns null silently disables every
// downstream branch (camera follow, AI targeting, etc.). The runtime
// entity name is the title-cased version of the def key
// (level_assembler.ts:nameFromRef: "player_car" → "Player Car"), unless
// a 03_worlds.json placement gives an explicit `name` override. Engine's
// findEntityByName falls back to a case-insensitive scan, so we accept
// case-insensitive matches.
(function checkNameLookups() {
    var knownNames = new Set();
    function titleCase(key) {
        return key.split('_').map(function(w) {
            return w.charAt(0).toUpperCase() + w.slice(1);
        }).join(' ');
    }
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        knownNames.add(titleCase(defKeys[di]));
    }
    var worlds = loadJSON('03_worlds.json');
    var worldList = (worlds && worlds.worlds) || worlds || [];
    if (!Array.isArray(worldList) && worldList && typeof worldList === 'object') {
        worldList = Object.values(worldList);
    }
    for (var wi = 0; wi < (worldList || []).length; wi++) {
        var placements = (worldList[wi] && worldList[wi].placements) || [];
        for (var pi = 0; pi < placements.length; pi++) {
            if (placements[pi] && typeof placements[pi].name === 'string') {
                knownNames.add(placements[pi].name);
            }
        }
    }
    // Scripts can rename entities via `entity.name = "..."`. Rare, but
    // accept these as known to avoid FPs.
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var src = stripCommentsForScan(scriptEntries[sei][1]);
        for (var nm of src.matchAll(/\.name\s*=\s*["']([^"']+)["']/g)) knownNames.add(nm[1]);
    }
    var lowerNames = new Set();
    for (var n of knownNames) lowerNames.add(n.toLowerCase());

    // Coalesce `||`-chained fallback lookups so we don't flag a backup
    // name when the primary one resolves. _entity_label.ts uses
    // `findEntityByName("Camera") || findEntityByName("Main Camera")` —
    // the chain is OK as long as at least one member resolves.
    function isKnown(name) {
        return knownNames.has(name) || lowerNames.has(name.toLowerCase());
    }

    var nameErrors = [];
    var seen = new Set();
    for (var sei2 = 0; sei2 < scriptEntries.length; sei2++) {
        var scriptKey = scriptEntries[sei2][0];
        var src2 = stripCommentsForScan(scriptEntries[sei2][1]);
        // First, build the set of names that participate in a `||`-chain
        // where at least one alternative resolves — those are valid.
        var chainSafe = new Set();
        for (var cm of src2.matchAll(
            /findEntityByName\s*\(\s*["']([^"']+)["']\s*\)(\s*\|\|\s*(?:\w+\.)*findEntityByName\s*\(\s*["']([^"']+)["']\s*\))+/g
        )) {
            // Re-scan the matched chain to extract every name in it.
            var chainNames = [];
            var chainMatches = cm[0].matchAll(/findEntityByName\s*\(\s*["']([^"']+)["']\s*\)/g);
            for (var cmInner of chainMatches) chainNames.push(cmInner[1]);
            if (chainNames.some(isKnown)) {
                for (var cn of chainNames) chainSafe.add(cn);
            }
        }
        for (var fm of src2.matchAll(/\bfindEntityByName\s*\(\s*["']([^"']+)["']\s*\)/g)) {
            var lookup = fm[1];
            if (isKnown(lookup) || chainSafe.has(lookup)) continue;
            var key = scriptKey + '|' + lookup;
            if (seen.has(key)) continue;
            seen.add(key);
            // Build a hint with the closest title-cased candidates so the
            // author sees the right runtime name to use.
            var candidates = [];
            for (var c of knownNames) {
                if (c.toLowerCase().indexOf(lookup.toLowerCase().split(' ')[0]) >= 0 ||
                    lookup.toLowerCase().indexOf(c.toLowerCase()) >= 0) candidates.push(c);
            }
            var hint = candidates.length > 0
                ? ' Closest known runtime names: ' + candidates.slice(0, 3).map(function(x) { return '"' + x + '"'; }).join(', ') + '.'
                : '';
            nameErrors.push(
                scriptKey + ': findEntityByName("' + lookup + '") will always return null — ' +
                'no entity is registered under that name. Runtime entity names are derived by title-casing the ' +
                '02_entities.json def key (e.g. "player_car" → "Player Car"), or by an explicit `name` field on ' +
                'a 03_worlds.json placement.' + hint
            );
        }
    }
    if (nameErrors.length > 0) {
        console.error('Name-lookup validation failed: ' + nameErrors.length + ' broken lookup(s). ' + nameErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 11. setPosition(this.entity.id) in onUpdate must run on a kinematic body
// ═════════════════════════════════════════════════════════════════════
// Two failure modes share this static signature:
//   - static rigidbody: collider teleports under riders without firing
//     carryKinematicRiders, so the player won't ride a moving platform.
//   - dynamic rigidbody: setPosition routes through rb.teleport which
//     calls setLinvel(0). Every frame zeros the body's velocity, so
//     gravity / knockback / authored forces never accumulate — the body
//     looks alive (visual updates each frame) but no physics actually
//     applies to it.
// Either way, if the script fully owns this entity's position, the
// entity should be physics.type=kinematic. If physics IS supposed to
// integrate (gravity, knockback), the script should use setLinearVelocity
// instead of setPosition.
function extractMethodBody(src, name) {
    var m = src.match(new RegExp(name + '\\s*\\([^)]*\\)\\s*\\{'));
    if (!m) return '';
    var i = m.index + m[0].length;
    var depth = 1;
    while (i < src.length && depth > 0) {
        var c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
    }
    return src.slice(m.index, i);
}
(function checkScriptOwnedMotion() {
    var motionErrors = [];
    var seen = new Set();
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var key = defKeys[di];
        var def = defs[key];
        if (!def || def.physics === false) continue;
        if (!def.mesh) continue;
        var ptype = ((def.physics && def.physics.type) || 'static').toLowerCase();
        if (ptype === 'kinematic') continue;
        var behaviors = def.behaviors || [];
        for (var bi = 0; bi < behaviors.length; bi++) {
            var spath = behaviors[bi].script || behaviors[bi].path;
            if (!spath) continue;
            var src = allScripts['behaviors/' + spath.replace(/^\/+/, '')]
                   || allScripts['systems/' + spath.replace(/^\/+/, '')];
            if (!src) continue;
            var clean = stripCommentsForScan(src);
            var onUpd = extractMethodBody(clean, 'onUpdate') ||
                        extractMethodBody(clean, 'onFixedUpdate');
            if (!onUpd) continue;
            if (!/\b(?:scene|self\.scene|this\.scene)\.setPosition\s*\(\s*(?:this\.entity(?:\.id)?|self\.entity(?:\.id)?)\s*,/.test(onUpd)) continue;
            // Skip if the same onUpdate also drives velocity — the
            // setPosition is a targeted teleport (Z-lock, fall-through
            // recovery, etc.) and physics integration is otherwise
            // intended. The bug shape we're after is "script fully owns
            // position", which precludes setVelocity calls.
            if (/\b(?:scene|self\.scene|this\.scene)\.(?:setVelocity|setLinearVelocity)\s*\(/.test(onUpd)) continue;
            var dedupe = key + '|' + spath;
            if (seen.has(dedupe)) continue;
            seen.add(dedupe);
            motionErrors.push(
                'entity "' + key + '" (physics.type=' + ptype + ') has behavior "' + spath +
                '" that calls scene.setPosition(this.entity.id, ...) inside onUpdate. ' +
                (ptype === 'static'
                    ? 'A static rigidbody can\'t carry riders — physics_system.ts carryKinematicRiders only iterates kinematic bodies, so the player won\'t ride this entity. '
                    : 'Dynamic + setPosition zeros linear velocity every frame (rb.teleport calls setLinvel(0)), so gravity/knockback/forces never accumulate — the body looks alive but no physics applies. ') +
                'If the script fully owns position, set physics.type="kinematic" in 02_entities.json. ' +
                'If physics IS meant to integrate, use scene.setLinearVelocity(this.entity.id, vec) instead of setPosition.'
            );
        }
    }
    if (motionErrors.length > 0) {
        console.error('Script-owned-motion validation failed: ' + motionErrors.length + ' entity behavior(s). ' + motionErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 12. Cuboid collider halfExtents must not be double-scaled
// ═════════════════════════════════════════════════════════════════════
// physics_system.ts:378 builds the runtime cuboid as
// `RAPIER.ColliderDesc.cuboid(he.x * sx, he.y * sy, he.z * sz)` where
// (sx, sy, sz) is the entity's worldScale, which equals mesh.scale.
// If the author wrote halfExtents in WORLD units (i.e. matching the
// visible mesh's halfsize), the runtime collider ends up at
// mesh.scale²/2 instead of mesh.scale/2 — wildly oversized in any
// non-unit axis.
//
// Caught in noodle_jaunt (player legs sank into floor because collider
// was 0.25m thick instead of 0.5m visible) and 33 more entities across
// 9 templates. The unmistakable signature: halfExtents == mesh.scale/2
// on a primitive-mesh entity (cube/sphere/etc.) with non-unit scale.
//
// Fix the LLM/author should apply: `halfExtents` lives in LOCAL units,
// so [0.5, 0.5, 0.5] (the engine default) plus mesh.scale yields a
// collider matching the visible cube. Or drop the explicit collider
// block entirely.
(function checkColliderHalfExtents() {
    var heErrors = [];
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var key = defKeys[di];
        var def = defs[key];
        if (!def || def.physics === false || !def.mesh) continue;
        var col = def.physics && def.physics.collider;
        if (!col || typeof col !== 'object') continue;
        var shape = col.shape || col.shapeType;
        if (shape !== 'cuboid' && shape !== 'box') continue;
        var he = col.halfExtents;
        if (!Array.isArray(he) || he.length < 3) continue;
        var sc = def.mesh.scale;
        if (!Array.isArray(sc) || sc.length < 3) continue;
        // Skip unit-scale entities — the engine multiply is a no-op there
        // and `halfExtents = mesh.scale/2` happens to be the correct
        // [0.5, 0.5, 0.5] anyway.
        if (sc[0] === 1 && sc[1] === 1 && sc[2] === 1) continue;
        var hx = Number(he[0]), hy = Number(he[1]), hz = Number(he[2]);
        var sx = Number(sc[0]), sy = Number(sc[1]), sz = Number(sc[2]);
        if (!isFinite(hx) || !isFinite(hy) || !isFinite(hz)) continue;
        if (!isFinite(sx) || !isFinite(sy) || !isFinite(sz)) continue;
        var matchX = Math.abs(hx - sx / 2) < 0.01 + 0.05 * Math.abs(sx / 2);
        var matchY = Math.abs(hy - sy / 2) < 0.01 + 0.05 * Math.abs(sy / 2);
        var matchZ = Math.abs(hz - sz / 2) < 0.01 + 0.05 * Math.abs(sz / 2);
        if (!(matchX && matchY && matchZ)) continue;
        var finalSize = [hx * sx, hy * sy, hz * sz];
        var visibleHalf = [sx / 2, sy / 2, sz / 2];
        heErrors.push(
            'entity "' + key + '" has physics.collider.halfExtents = [' +
            hx + ', ' + hy + ', ' + hz + '] but mesh.scale = [' +
            sx + ', ' + sy + ', ' + sz + '] — physics_system multiplies ' +
            'halfExtents by worldScale (= mesh.scale), so the runtime collider ' +
            'is sized [' + finalSize.map(function(n) { return n.toFixed(3); }).join(', ') +
            '] (full half-extents) instead of the intended [' +
            visibleHalf.map(function(n) { return n.toFixed(3); }).join(', ') +
            ']. halfExtents is in LOCAL units; use [0.5, 0.5, 0.5] (or drop ' +
            'the collider block entirely so the engine defaults match the ' +
            'cube primitive\'s native bounds).'
        );
    }
    if (heErrors.length > 0) {
        console.error('Collider halfExtents validation failed: ' + heErrors.length + ' entit' + (heErrors.length > 1 ? 'ies' : 'y') + '. ' + heErrors[0]);
        process.exit(1);
    }
})();


console.log('Assembler check passed (' + Object.keys(allScripts).length + ' scripts, ' + Object.keys(uiFiles).length + ' UI panels checked).');
