// validate_assembler_script.js — Strict assembler validation.
//
// Runs the exact same validation checks as assembleGame() in
// level_assembler.ts, entirely offline using the sandbox's project/
// directory. Replaces the HTTP-based approach that soft-failed when
// the backend was unreachable (e.g. Docker on remote workers).
//
// The validation categories, checked in order (first failure exits):
//   1. Event validation — unknown game events, wrong bus, missing payload fields
//   2. Reference validation — missing behavior/system files, missing UI panels
//   3. FSM structural — missing start fields, unknown active_behaviors/systems
//   4. spawnEntity — unknown entity definition references
//   5. UI button — ui_event transitions referencing missing panel buttons
//  5b. postMessage wire-format — panel HTMLs must use type: 'game_command'
//   6. hud_update key collision — system keys shadowed by FSM reserved keys
//   7. Inline onclick IIFE — onclick attrs calling IIFE-scoped functions
//   8. Asset path validation — mesh assets, audio, textures vs asset catalogs
//   9-13. Tag/name lookups, kinematic-body / camera / collider / decoration /
//        body-type / Play-Again rules
//  14. Click pattern — cursor_click events vs cached cursor_move + MouseLeft poll
//  15. World-to-HUD scale — worldToScreen → hud_update needs iframe-scale compensation

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

// Engine-machinery script paths to skip from user-code-rule checks (tag-
// lookup, name-lookup, etc.). These are shipped infrastructure files;
// they look up entities every game won't have ("Camera" in a UI game,
// "Player" in a board game). The user doesn't own these and the engine
// handles the null fallback gracefully. Mirror of the TRANSPORT_RE
// filter inside the dead_listener invariant in headless/src/invariants.ts.
var ENGINE_MACHINERY_RE = /(^|\/)(ui_bridge|mp_bridge|fsm_driver|_entity_label|event_definitions|_event_validator)(_[^/]*)?\.ts$/;

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
// 3b. Controls-manifest shape validation
// ═════════════════════════════════════════════════════════════════════
//
// 01_flow.json:controls drives the on-screen mobile overlay (joystick,
// look pad, action buttons, hotbar, system tray). Catch typo'd preset
// names, invalid enum values, wrong types, and reserved-key collisions
// here so the agent gets a precise build error instead of silently
// degrading at runtime. Mirrors validateControlManifest() in
// engine/shared/input/control_manifest.ts — keep them in sync.
(function () {
    var raw = flow && Object.prototype.hasOwnProperty.call(flow, 'controls') ? flow.controls : undefined;
    if (raw === undefined || raw === null) return; // absent is allowed
    var errs = [];
    var RESERVED_KEYS = { KeyP: 1, KeyV: 1, Enter: 1, Escape: 1 };

    if (typeof raw !== 'object' || Array.isArray(raw)) {
        errs.push('controls: must be a JSON object');
    } else {
        var m = raw;

        if (m.preset !== undefined) {
            var validPresets = ['fps','tps','topdown','platformer','sidescroller','racer','flight','rts','click','custom'];
            if (typeof m.preset !== 'string' || validPresets.indexOf(m.preset) < 0) {
                errs.push('controls.preset: "' + m.preset + '" — must be one of ' + validPresets.join(' | '));
            }
        }

        if (m.movement !== undefined) {
            if (typeof m.movement !== 'object' || m.movement === null || Array.isArray(m.movement)) {
                errs.push('controls.movement: must be an object');
            } else {
                if (m.movement.type !== undefined) {
                    var vt = ['wasd','arrows','wasd+arrows','horizontal','none'];
                    if (typeof m.movement.type !== 'string' || vt.indexOf(m.movement.type) < 0) {
                        errs.push('controls.movement.type: "' + m.movement.type + '" — must be one of ' + vt.join(' | '));
                    }
                }
                ['sprint','crouch','jump'].forEach(function (f) {
                    if (m.movement[f] !== undefined && typeof m.movement[f] !== 'string') {
                        errs.push('controls.movement.' + f + ': must be a key-code string');
                    }
                });
            }
        }

        if (m.look !== undefined) {
            if (typeof m.look !== 'object' || m.look === null || Array.isArray(m.look)) {
                errs.push('controls.look: must be an object');
            } else {
                if (m.look.type !== undefined) {
                    var lt = ['mouseDelta','tapToFace','none'];
                    if (typeof m.look.type !== 'string' || lt.indexOf(m.look.type) < 0) {
                        errs.push('controls.look.type: "' + m.look.type + '" — must be one of ' + lt.join(' | '));
                    }
                }
                if (m.look.sensitivity !== undefined && (typeof m.look.sensitivity !== 'number' || !isFinite(m.look.sensitivity))) {
                    errs.push('controls.look.sensitivity: must be a finite number');
                }
            }
        }

        if (m.fire !== undefined) {
            if (typeof m.fire !== 'object' || m.fire === null || Array.isArray(m.fire)) {
                errs.push('controls.fire: must be an object');
            } else {
                ['primary','secondary'].forEach(function (f) {
                    if (m.fire[f] !== undefined && typeof m.fire[f] !== 'string') {
                        errs.push('controls.fire.' + f + ': must be a key-code string');
                    }
                });
                ['label','secondaryLabel'].forEach(function (f) {
                    if (m.fire[f] !== undefined && typeof m.fire[f] !== 'string') {
                        errs.push('controls.fire.' + f + ': must be a string');
                    }
                });
                ['holdPrimary','holdSecondary'].forEach(function (f) {
                    if (m.fire[f] !== undefined && typeof m.fire[f] !== 'boolean') {
                        errs.push('controls.fire.' + f + ': must be true | false');
                    }
                });
            }
        }

        if (m.actions !== undefined) {
            if (!Array.isArray(m.actions)) {
                errs.push('controls.actions: must be an array of { key, label } entries');
            } else {
                m.actions.forEach(function (a, i) {
                    if (typeof a !== 'object' || a === null || Array.isArray(a)) {
                        errs.push('controls.actions[' + i + ']: must be an object with { key, label }');
                        return;
                    }
                    if (typeof a.key !== 'string' || a.key.length === 0) {
                        errs.push('controls.actions[' + i + '].key: must be a non-empty key-code string');
                    } else if (RESERVED_KEYS[a.key]) {
                        errs.push('controls.actions[' + i + '].key: "' + a.key + '" is engine-reserved (route through controls.system instead)');
                    }
                    if (typeof a.label !== 'string') {
                        errs.push('controls.actions[' + i + '].label: must be a string');
                    }
                    if (a.hold !== undefined && typeof a.hold !== 'boolean') {
                        errs.push('controls.actions[' + i + '].hold: must be true | false');
                    }
                    if (a.toggle !== undefined && typeof a.toggle !== 'boolean') {
                        errs.push('controls.actions[' + i + '].toggle: must be true | false');
                    }
                });
            }
        }

        if (m.hotbar !== undefined) {
            if (typeof m.hotbar !== 'object' || m.hotbar === null || Array.isArray(m.hotbar)) {
                errs.push('controls.hotbar: must be an object with { from, to }');
            } else {
                var shape = /^(Digit|F)\d+$/;
                if (typeof m.hotbar.from !== 'string' || !shape.test(m.hotbar.from)) {
                    errs.push('controls.hotbar.from: "' + m.hotbar.from + '" — must match Digit\\d+ or F\\d+');
                }
                if (typeof m.hotbar.to !== 'string' || !shape.test(m.hotbar.to)) {
                    errs.push('controls.hotbar.to: "' + m.hotbar.to + '" — must match Digit\\d+ or F\\d+');
                }
                if (m.hotbar.labels !== undefined && !Array.isArray(m.hotbar.labels)) {
                    errs.push('controls.hotbar.labels: must be an array of strings');
                }
            }
        }

        if (m.scroll !== undefined) {
            if (typeof m.scroll !== 'object' || m.scroll === null || Array.isArray(m.scroll)) {
                errs.push('controls.scroll: must be an object');
            } else {
                if (m.scroll.type !== undefined) {
                    var st = ['pinch','twoFinger','none'];
                    if (typeof m.scroll.type !== 'string' || st.indexOf(m.scroll.type) < 0) {
                        errs.push('controls.scroll.type: "' + m.scroll.type + '" — must be one of ' + st.join(' | '));
                    }
                }
                if (m.scroll.sensitivity !== undefined && (typeof m.scroll.sensitivity !== 'number' || !isFinite(m.scroll.sensitivity))) {
                    errs.push('controls.scroll.sensitivity: must be a finite number');
                }
            }
        }

        if (m.viewport !== undefined) {
            if (typeof m.viewport !== 'object' || m.viewport === null || Array.isArray(m.viewport)) {
                errs.push('controls.viewport: must be an object');
            } else if (m.viewport.tap !== undefined) {
                var vts = ['click','drag','none'];
                if (typeof m.viewport.tap !== 'string' || vts.indexOf(m.viewport.tap) < 0) {
                    errs.push('controls.viewport.tap: "' + m.viewport.tap + '" — must be one of ' + vts.join(' | '));
                }
            }
        }

        if (m.system !== undefined) {
            if (typeof m.system !== 'object' || m.system === null || Array.isArray(m.system)) {
                errs.push('controls.system: must be an object');
            } else {
                ['pause','chat','voice','scoreboard'].forEach(function (f) {
                    if (m.system[f] !== undefined && typeof m.system[f] !== 'string') {
                        errs.push('controls.system.' + f + ': must be a key-code string');
                    }
                });
            }
        }

        if (m.hudKeys !== undefined) {
            if (!Array.isArray(m.hudKeys)) {
                errs.push('controls.hudKeys: must be an array of key-code strings');
            } else {
                m.hudKeys.forEach(function (k, i) {
                    if (typeof k !== 'string' || k.length === 0) {
                        errs.push('controls.hudKeys[' + i + ']: must be a non-empty key-code string');
                    }
                });
            }
        }
    }

    if (errs.length > 0) {
        console.error('controls manifest validation failed: ' + errs.length + ' error(s). ' + errs[0]);
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

    function checkKeysAgainstReserved(keys, scriptKey, hudErrors) {
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

    // Find the object literal body for a `var <name> = { ... }` declaration.
    function findVarObjectLiteral(source, varName) {
        var pat = new RegExp('(?:var|let|const)\\s+' + varName + '\\s*=\\s*\\{', 'g');
        var m;
        while ((m = pat.exec(source)) !== null) {
            var openIdx = m.index + m[0].length - 1;
            var depth = 0, end = -1;
            for (var i = openIdx; i < source.length; i++) {
                if (source[i] === '{') depth++;
                else if (source[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
            }
            if (end >= 0) return source.slice(openIdx, end + 1);
        }
        return null;
    }

    var hudErrors = [];
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];

        // Case 1: inline object literal — emit("hud_update", { ... })
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
            checkKeysAgainstReserved(keys, scriptKey, hudErrors);
        }

        // Case 2: variable reference — emit("hud_update", someVar)
        var reVar = /events\.ui\.emit\s*\(\s*['"]hud_update['"]\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g;
        var matchVar;
        while ((matchVar = reVar.exec(source)) !== null) {
            var varName = matchVar[1];
            if (varName === 'this' || varName === 'undefined' || varName === 'null') continue;
            var objLiteral = findVarObjectLiteral(source, varName);
            if (!objLiteral) continue;
            var keys = topLevelKeys(objLiteral);
            checkKeysAgainstReserved(keys, scriptKey, hudErrors);
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
        if (ENGINE_MACHINERY_RE.test(scriptKey)) continue;
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
                'and no spawnEntity target prefab carries it. Three valid resolutions: ' +
                '(1) DELETE the lookup if it\'s residue from a copied template/library that doesn\'t apply to this game; ' +
                '(2) tag the relevant entities (or addTag at runtime, or spawn a prefab carrying the tag); ' +
                '(3) fix the literal if you typoed.'
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
    // ENGINE_MACHINERY_RE is defined above in the tag-lookup block; re-use it.
    for (var sei2 = 0; sei2 < scriptEntries.length; sei2++) {
        var scriptKey = scriptEntries[sei2][0];
        if (ENGINE_MACHINERY_RE.test(scriptKey)) continue;
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
                'no entity is registered under that name. Three valid resolutions: ' +
                '(1) DELETE the lookup if it\'s residue from a copied template/library that doesn\'t apply to this game; ' +
                '(2) place an entity with this name in 03_worlds.json (runtime entity names are derived by title-casing the ' +
                '02_entities.json def key, e.g. "player_car" → "Player Car", or set explicitly via the placement\'s `name` field); ' +
                '(3) fix the literal if you typoed.' + hint
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
        // Camera entities are handled by check 11b (CameraComponent presence).
        // The kinematic/setLinearVelocity advice this check produces is wrong
        // for cameras — they need def.camera = { fov }, not a rigidbody. Skip
        // anything tagged "camera" or carrying a camera_* behavior.
        var camTags = def.tags || [];
        if (camTags.indexOf('camera') !== -1) continue;
        var camBehaviors = def.behaviors || [];
        var isCameraBehaviorEntity = false;
        for (var ci = 0; ci < camBehaviors.length; ci++) {
            var cpath = camBehaviors[ci].script || camBehaviors[ci].path || camBehaviors[ci].name || '';
            if (/^camera[_/]/.test(cpath) || /\/camera_/.test(cpath)) { isCameraBehaviorEntity = true; break; }
        }
        if (isCameraBehaviorEntity) continue;
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
// 11b. Camera entities must declare def.camera so a CameraComponent mounts
// ═════════════════════════════════════════════════════════════════════
// level_assembler.ts:358 only attaches a CameraComponent when the entity
// definition has a `camera` field (`{ fov, near, far }`). scene.ts:742
// getActiveCamera() iterates entities looking for a CameraComponent — no
// component, no active camera, renderer keeps its default view matrix.
//
// The trap: agents write a "camera" entity with tags:["camera"] and a
// camera_third_person / camera_platformer behavior, but omit the nested
// def.camera block. The behavior runs and calls scene.setPosition +
// entity.transform.lookAt every frame, but those updates aren't bound to
// any render camera — game ships with a frozen view. Validator passes,
// playtest invariants pass, user sees a static camera looking at origin.
(function checkCameraComponentPresence() {
    var cameraErrors = [];
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var key = defKeys[di];
        var def = defs[key];
        if (!def) continue;
        var tags = def.tags || [];
        var behaviors = def.behaviors || [];
        var taggedCamera = tags.indexOf('camera') !== -1;
        var hasCameraBehavior = false;
        for (var bi = 0; bi < behaviors.length; bi++) {
            var spath = behaviors[bi].script || behaviors[bi].path || behaviors[bi].name || '';
            if (/^camera[_/]/.test(spath) || /\/camera_/.test(spath) || /^camera_/.test(spath)) {
                hasCameraBehavior = true;
                break;
            }
        }
        if (!taggedCamera && !hasCameraBehavior) continue;
        if (def.camera) continue;
        cameraErrors.push(
            'entity "' + key + '" looks like a camera (' +
            (taggedCamera ? 'tags includes "camera"' : 'carries a camera_* behavior') +
            ') but has no def.camera = { fov } — level_assembler.ts:358 will not mount a CameraComponent, so scene.getActiveCamera() returns null and the renderer keeps its default view. The camera-follow behavior will run as a no-op for rendering. Add "camera": { "fov": 60 } to the entity definition in 02_entities.json.'
        );
    }
    if (cameraErrors.length > 0) {
        console.error('Camera-component validation failed: ' + cameraErrors.length + ' entit' + (cameraErrors.length > 1 ? 'ies' : 'y') + '. ' + cameraErrors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 12. Collider dimensions are authored — auto-fit will overwrite them
// ═════════════════════════════════════════════════════════════════════
// Colliders auto-fit to the visible mesh's AABB at load time
// (editor_context.autoFitCollider) and the assembler strips authored
// dimensions on the way through (level_assembler.buildColliderData),
// so any value here is silently ignored at runtime — the runtime
// collider always matches the visible mesh, full stop.
//
// This check is a **WARNING, not an error**: emitting a non-zero exit
// would break ~40% of pre-existing user projects that were authored
// before the auto-fit invariant landed, since cli_fixer re-runs
// validate.sh against the project's frozen 02_entities.json. The
// runtime is correct either way (assembler strips, autoFit applies);
// the warning's only job is to prompt the LLM to clean the template
// when it's already touching the file.
//
// Author the shape only:
//   `physics.collider: "box" | "capsule" | "sphere" | "mesh"` (string),
//   or `{ "shape": "...", "is_trigger"?: bool }` (object — trigger flag
//   only). If a collider is wrong-sized, the *mesh* is wrong: scale
//   the mesh, swap the asset, or fix the asset pivot.
(function warnColliderHasNoAuthoredDims() {
    var FORBIDDEN = ['halfExtents', 'size', 'radius', 'height', 'halfHeight', 'center', 'disableAutoFit'];
    var dimWarnings = [];
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var key = defKeys[di];
        var def = defs[key];
        if (!def || def.physics === false) continue;
        var col = def.physics && def.physics.collider;
        if (!col || typeof col !== 'object') continue;
        var found = [];
        for (var fi = 0; fi < FORBIDDEN.length; fi++) {
            if (col[FORBIDDEN[fi]] !== undefined) found.push(FORBIDDEN[fi]);
        }
        if (found.length > 0) {
            dimWarnings.push(
                'entity "' + key + '" has [' + found.join(', ') +
                '] on physics.collider — these are silently ignored ' +
                '(colliders auto-fit to the visible mesh AABB). Replace with `"collider": "' +
                (col.shape || col.shapeType || 'box') + '"`' +
                (col.is_trigger ? ' or `{"shape":"' + (col.shape || col.shapeType || 'box') + '","is_trigger":true}`' : '') +
                ' next time you touch this file.'
            );
        }
    }
    if (dimWarnings.length > 0) {
        console.warn(
            '[validate-assembler] ' + dimWarnings.length +
            ' authored-collider-dimensions warning' + (dimWarnings.length > 1 ? 's' : '') +
            ' (non-fatal, runtime is correct):\n  - ' +
            dimWarnings.slice(0, 3).join('\n  - ') +
            (dimWarnings.length > 3 ? '\n  - ...(+' + (dimWarnings.length - 3) + ' more)' : ''),
        );
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 12c. Primitive mesh + collider:"mesh" — wrong primitive, mis-fit hull
// ═════════════════════════════════════════════════════════════════════
// When mesh.type is a primitive shape (sphere/cube/box/plane/cylinder/
// capsule), physics.collider should be the matching primitive — never
// "mesh". A "mesh" collider builds a triangle hull from the geometry,
// which (a) is heavier at runtime than a primitive and (b) doesn't fit
// the visible shape correctly when the mesh is non-uniformly scaled
// (a sphere mesh squashed on Y becomes an ellipsoidal triangle hull;
// the primitive sphere collider would auto-fit to the AABB instead).
//
// Engine has no native cylinder or plane primitive collider, so the
// recommendation falls back to the closest fit: cylinder → capsule,
// plane → box. (See level_assembler.buildColliderData accepted shapes:
// box/cuboid, sphere/ball, capsule, mesh.)
//
// Warning, not error — same reasoning as check 12: many existing
// projects predate this rule and an error would put cli_fixer into a
// fail loop on legacy 02_entities.json files it isn't otherwise touching.
(function warnPrimitiveMeshWithMeshCollider() {
    var SUGGESTED_COLLIDER = {
        sphere:   'sphere',
        cube:     'box',
        box:      'box',
        capsule:  'capsule',
        cylinder: 'capsule',
        plane:    'box',
    };
    var warnings = [];
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var key = defKeys[di];
        var def = defs[key];
        if (!def || def.physics === false || !def.mesh) continue;
        var meshType = def.mesh.type;
        if (!meshType || !SUGGESTED_COLLIDER.hasOwnProperty(meshType)) continue;
        var col = def.physics && def.physics.collider;
        var actualShape = (typeof col === 'string') ? col
                        : (col && typeof col === 'object') ? (col.shape || col.shapeType)
                        : null;
        if (actualShape !== 'mesh') continue;
        warnings.push(
            'entity "' + key + '" has mesh.type="' + meshType + '" (primitive) ' +
            'but physics.collider="mesh" — use "' + SUGGESTED_COLLIDER[meshType] + '" instead. ' +
            'A mesh collider on a primitive builds a triangle hull from the geometry ' +
            '(heavier at runtime; non-uniform scales produce a hull that won\'t fit a ' +
            'primitive — e.g. a sphere mesh scaled [30,8,30] gets an ellipsoidal hull ' +
            'instead of an auto-fit sphere). Fix next time you touch this file.'
        );
    }
    if (warnings.length > 0) {
        console.warn(
            '[validate-assembler] ' + warnings.length +
            ' primitive-mesh-with-mesh-collider warning' + (warnings.length > 1 ? 's' : '') +
            ' (non-fatal):\n  - ' +
            warnings.slice(0, 3).join('\n  - ') +
            (warnings.length > 3 ? '\n  - ...(+' + (warnings.length - 3) + ' more)' : ''),
        );
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 12b. decoration_only on physical geometry (no collider) — bug class
// ═════════════════════════════════════════════════════════════════════
// `decoration_only` is the agent's escape hatch for "no collision needed —
// purely visual." It causes invariants (interactive_entities_have_colliders)
// to skip the entity. The trap: agents sometimes use it on entities that
// the player WILL physically interact with (drive over a ramp, walk on a
// platform), then implement the interaction via a proximity-zone behavior.
// The kart_rally regression: ramp_jump tagged decoration_only + physics:false,
// using track_zones.ts to detect ramp proximity and apply a vertical impulse.
// User feedback: "ramp doesn't have collider" — they expected to drive on it.
//
// Tight name regex: only flags terms unambiguously describing solid
// surface/structure geometry the player walks on or bumps into. Excludes
// pickup-y names (coin/gem/orb/powerup) which legitimately use proximity
// triggers. Excludes enemy names — those are AI agents with their own
// physics setups. False-positive risk is minimal because the conjunction of
// (physical name) AND (decoration_only tag) AND (no physics) is highly
// specific to the bug pattern.
(function checkDecorationOnlyOnPhysicalGeometry() {
    // Tight regex of names that almost always describe player-interactive
    // structural geometry. Excludes terms with frequent decorative use
    // (floor / ceiling / roof / track / pipe — water surfaces, sky, sea
    // floor, racetrack signage). Custom non-letter-border match instead of
    // \b — JS \b treats `_` as a word char, so \bramp\b would NOT match
    // "ramp_jump" (the canonical bug). Underscore-segmented names are the
    // engine's idiomatic style; we want each segment matched independently.
    var PHYSICAL_GEOMETRY_RE = /(^|[^a-z])(ramp|stair|stairs|step|platform|wall|fence|barrier|bridge|gateway|gate|door|pillar|column|catwalk|scaffold|ledge|obstacle)([^a-z]|$)/i;

    // Tag names common in scaffolding / decoration that don't signal
    // gameplay relevance even when present alongside decoration_only.
    var GENERIC_TAGS = new Set(['decoration_only', 'no_collide', 'building', 'environment', 'background', 'vfx', 'particle', 'backdrop', 'effect', 'decoration']);

    // Concatenate all .ts files under project/behaviors and project/systems
    // (recursive). The flag fires only when an entity's tag or def-key
    // appears as a literal in this corpus — strong signal that gameplay
    // code references the entity. Avoids false positives on truly
    // decorative entities whose names happen to contain "wall" / "ramp"
    // (e.g. "wall_painting", "fence_railing_visual").
    function scanScriptCorpus() {
        var bigString = '';
        function walk(dir) {
            var entries;
            try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
            for (var i = 0; i < entries.length; i++) {
                var ent = entries[i];
                var full = path.join(dir, ent.name);
                if (ent.isDirectory()) walk(full);
                else if (ent.isFile() && ent.name.endsWith('.ts')) {
                    try { bigString += fs.readFileSync(full, 'utf-8') + '\n'; } catch (e) {}
                }
            }
        }
        walk(path.join(PROJECT, 'behaviors'));
        walk(path.join(PROJECT, 'systems'));
        return bigString;
    }
    var scriptCorpus = null;  // lazy

    var errors = [];
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var key = defKeys[di];
        var def = defs[key];
        if (!def) continue;
        if (def.physics && def.physics !== false) continue;  // has a real physics block — fine
        var tags = Array.isArray(def.tags) ? def.tags : [];
        if (tags.indexOf('decoration_only') === -1) continue;
        if (!PHYSICAL_GEOMETRY_RE.test(key)) continue;

        // Confirming signal: entity's def-key OR a non-generic tag appears
        // in some behavior/system file. Without this, a "wall_painting"
        // tagged decoration_only wouldn't be a bug — it's a real visual
        // prop that no code interacts with.
        if (scriptCorpus === null) scriptCorpus = scanScriptCorpus();
        var referenced = false;
        var refSignal = '';
        if (scriptCorpus.indexOf('"' + key + '"') !== -1 || scriptCorpus.indexOf("'" + key + "'") !== -1) {
            referenced = true; refSignal = 'def-key "' + key + '"';
        } else {
            for (var ti = 0; ti < tags.length; ti++) {
                var t = tags[ti];
                if (typeof t !== 'string' || GENERIC_TAGS.has(t)) continue;
                if (scriptCorpus.indexOf('"' + t + '"') !== -1 || scriptCorpus.indexOf("'" + t + "'") !== -1) {
                    referenced = true; refSignal = 'tag "' + t + '"';
                    break;
                }
            }
        }
        if (!referenced) continue;

        errors.push(
            'entity "' + key + '" is tagged "decoration_only" with no physics, but its name describes ' +
            'physical geometry AND a behavior/system references it (' + refSignal + '). ' +
            'decoration_only is ONLY for purely visual props the player never walks on, drives over, ' +
            'or bumps into. Since gameplay code references this entity, the player will interact with it ' +
            '— remove "decoration_only" from tags AND add a physics block ' +
            '(`"physics": { "type": "static", "collider": "box" }` is the safe default — auto-fits to ' +
            'the visible mesh AABB). If you intended the interaction to be proximity-only ' +
            '(no physical collision), use a trigger collider instead: ' +
            '`"physics": { "type": "static", "collider": { "shape": "box", "is_trigger": true } }`.'
        );
    }
    if (errors.length > 0) {
        console.error('decoration_only-on-physical-geometry validation failed: ' + errors.length +
            ' entit' + (errors.length > 1 ? 'ies' : 'y') + '. ' + errors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 12c. Behavior requires DYNAMIC rigidbody — bug class
// ═════════════════════════════════════════════════════════════════════
// Scripts that drive movement via `this.scene.setVelocity(this.entity, ...)`
// only work on DYNAMIC bodies. The physics system's applyPreStepForces
// loop early-returns on non-dynamic types (kinematic/static/none), so the
// velocity is silently dropped. The pickaxe_duel regression:
// player.physics.type set to "kinematic", behaviors include
// third_person_movement which calls scene.setVelocity — agent didn't know
// the incompatibility, validate didn't catch it, user feedback: "can't move."
//
// Detection: read each behavior's source file from project/behaviors/ and
// regex-match the canonical self-velocity-set pattern. If found, the
// entity referencing that behavior must have physics.type === "dynamic".
//
// Self-targeted match (this.scene.setVelocity(this.entity...) only) keeps
// false positives near zero — behaviors that set velocity on OTHER entities
// (AI controllers driving a player, etc.) don't trigger.
(function checkBehaviorRequiresDynamicBody() {
    var SELF_SET_VELOCITY_RE = /this\.scene\.setVelocity\s*\(\s*this\.entity\b/;
    var behaviorCache = {};  // path → { needsDynamic: bool, exists: bool }
    function inspectBehavior(scriptPath) {
        if (behaviorCache[scriptPath]) return behaviorCache[scriptPath];
        var rec = { needsDynamic: false, exists: false };
        var rel = scriptPath.replace(/^\/+/, '');
        var fullPath = path.join(PROJECT, 'behaviors', rel);
        try {
            var src = fs.readFileSync(fullPath, 'utf-8');
            rec.exists = true;
            rec.needsDynamic = SELF_SET_VELOCITY_RE.test(src);
        } catch (e) { /* missing — ref-validator will flag separately */ }
        behaviorCache[scriptPath] = rec;
        return rec;
    }
    var errors = [];
    var defKeys = Object.keys(defs);
    for (var di = 0; di < defKeys.length; di++) {
        var key = defKeys[di];
        var def = defs[key];
        if (!def || !Array.isArray(def.behaviors)) continue;
        for (var bi = 0; bi < def.behaviors.length; bi++) {
            var beh = def.behaviors[bi];
            if (!beh || !beh.script) continue;
            var info = inspectBehavior(beh.script);
            if (!info.exists || !info.needsDynamic) continue;
            // Behavior moves `this.entity` via setVelocity → entity must be DYNAMIC.
            var phys = def.physics;
            var bodyType = (phys && typeof phys === 'object') ? phys.type : null;
            if (phys === false) {
                errors.push(
                    'entity "' + key + '" uses behavior "' + (beh.name || beh.script) +
                    '" (which calls scene.setVelocity on this.entity) but has "physics": false. ' +
                    'Behaviors that drive movement via setVelocity require a DYNAMIC rigidbody. ' +
                    'Add `"physics": { "type": "dynamic", "mass": 75, "freeze_rotation": true, "collider": "capsule" }` ' +
                    '(adjust mass/collider as appropriate).'
                );
            } else if (!phys || bodyType !== 'dynamic') {
                errors.push(
                    'entity "' + key + '" uses behavior "' + (beh.name || beh.script) +
                    '" (which calls scene.setVelocity on this.entity) but physics.type is "' +
                    (bodyType || 'static (default)') + '". Behaviors that drive movement via ' +
                    'setVelocity require physics.type = "dynamic" — kinematic / static bodies ' +
                    'silently ignore velocity in physics_system.applyPreStepForces. Either change to ' +
                    '"dynamic" (with mass + freeze_rotation as needed), or swap the behavior for one ' +
                    'that mutates transform.position directly (e.g., player_arena_movement.ts).'
                );
            }
        }
    }
    if (errors.length > 0) {
        console.error('behavior-body-type validation failed: ' + errors.length +
            ' issue' + (errors.length > 1 ? 's' : '') + '. ' + errors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 13. AI behavior Play Again reset
// ═════════════════════════════════════════════════════════════════════
//
// A behavior that:
//   (a) declares a `_dead` field, AND
//   (b) listens for `entity_damaged`, AND
//   (c) sets `_dead = true` somewhere (typically inside that handler),
// MUST register at least one reset listener for `game_ready`,
// `match_started`, or `restart_game` — otherwise the entity stays
// deactivated permanently and the next match starts with the entity
// gone. Caught the c4ff23a regression class across 10 shared AI
// behaviors (boss_ai, hostile_ai, hostile_mob, minion_ai, pedestrian_ai,
// police_ai, medic_ai, farm_animal_ai, ghost_ship, sea_monster).
(function() {
    var resetEvents = ['game_ready', 'match_started', 'restart_game'];
    var missing = [];
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];
        // Only behaviors. Systems can manage their own state without per-entity reset.
        if (!scriptKey.startsWith('behaviors/')) continue;
        // (a) has _dead field
        if (!/(?:^|\s)_dead\s*=/.test(source)) continue;
        // (b) listens for entity_damaged
        if (!/\.events\.game\.on\(\s*["']entity_damaged["']/.test(source)) continue;
        // (c) sets _dead = true (i.e. the listener actually deactivates)
        if (!/_dead\s*=\s*true/.test(source)) continue;
        // Must subscribe to at least one reset event
        var hasReset = false;
        for (var ri = 0; ri < resetEvents.length; ri++) {
            var ev = resetEvents[ri];
            var re = new RegExp('\\.events\\.game\\.on\\(\\s*["\']' + ev + '["\']');
            if (re.test(source)) { hasReset = true; break; }
        }
        if (!hasReset) missing.push(scriptKey);
    }
    if (missing.length > 0) {
        console.error(
            'Play Again reset check failed: ' + missing.length + ' AI behavior(s) ' +
            'track _dead but never reset on game_ready/match_started/restart_game. ' +
            'Affected: ' + missing.join(', ') + '. Once an enemy dies, it stays ' +
            'deactivated permanently — the next match starts missing those entities. ' +
            'Subscribe to ANY ONE of game_ready / match_started / restart_game (you do ' +
            'not need all three) and reset _dead=false, _health, position, and ' +
            'entity.active=true in the handler. Example: ' +
            '`this.scene.events.game.on("game_ready", function() { self._dead = false; ' +
            'self.entity.active = true; });` in onStart.'
        );
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 14. Click pattern — cursor_click vs cached cursor_move + MouseLeft poll
// ═════════════════════════════════════════════════════════════════════
//
// One-shot click intents (place a turret, select a unit, attack, loot,
// move order) MUST consume the `cursor_click` / `cursor_right_click`
// events emitted by ui_bridge. Polling `isKeyPressed("MouseLeft")` /
// `isKeyPressed("MouseRight")` against `_cursorX`/`_cursorY` cached from
// a `cursor_move` handler silently breaks taps on touch devices.
//
// ui_bridge emits `cursor_move` and then `cursor_click` synchronously on
// the press frame. On desktop the mouse moves continuously so the cached
// coords stay fresh; on touch a tap is the ONLY event that updates the
// cursor — and if this script's onUpdate runs before ui_bridge's, the
// cached coords are one tap stale (action lands at the previous click
// location). The fix is mechanical: subscribe to `cursor_click` /
// `cursor_right_click` and use the event's `d.x` / `d.y` directly.
//
// Reference good patterns: chess_interaction.ts, rts_input.ts,
// kitchen_master_engine.ts (all consume cursor_click events).
(function checkClickPattern() {
    var warnings = [];
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];
        if (ENGINE_MACHINERY_RE.test(scriptKey)) continue;
        // Only flag scripts that BOTH cache cursor_move AND poll
        // isKeyPressed("MouseLeft|Right"). isKeyDown is intentionally
        // allowed — held-fire / continuous-aim patterns re-read every
        // frame so the cache stays fresh by definition.
        var hasCursorMove = /\.events\.ui\.on\(\s*["']cursor_move["']/.test(source);
        if (!hasCursorMove) continue;
        var pollLeft  = /isKeyPressed\(\s*["']MouseLeft["']\s*\)/.test(source);
        var pollRight = /isKeyPressed\(\s*["']MouseRight["']\s*\)/.test(source);
        if (!pollLeft && !pollRight) continue;
        var which = (pollLeft && pollRight) ? 'MouseLeft + MouseRight'
                  : (pollLeft ? 'MouseLeft' : 'MouseRight');
        warnings.push(scriptKey + ' (polls isKeyPressed("' + which + '"))');
    }
    if (warnings.length > 0) {
        console.error(
            'Click-pattern check failed: ' + warnings.length + ' script(s) cache ' +
            'cursor_move and poll isKeyPressed("MouseLeft" / "MouseRight"). ' +
            'On touch devices a tap is the only event that moves the cursor — ' +
            'if this script ticks before ui_bridge in the frame, the cached ' +
            '_cursorX/_cursorY is one tap stale and the action lands at the ' +
            'previous click. Replace with: ' +
            'this.scene.events.ui.on("cursor_click", function(d) { /* use d.x, d.y */ }); ' +
            '(and cursor_right_click for the right button). The event payload carries the ' +
            'press-frame canvas-relative coords. Affected: ' + warnings.join(', ') + '. ' +
            'Reference: chess_interaction.ts, rts_input.ts, kitchen_master_engine.ts.'
        );
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 15. World-anchored HUD scale — worldToScreen → hud_update payloads
//     must compensate for the iframe's CSS scale.
// ═════════════════════════════════════════════════════════════════════
//
// HUD HTMLs are loaded into iframes that html_ui_manager scales:
//   - non-responsive panels: transform: scale(canvas_w / 1920), so the
//     iframe's design width is fixed at 1920px. canvas-x → iframe-x
//     needs `* 1920 / canvas_w`.
//   - pp-responsive panels on coarse-pointer devices: hardcoded
//     transform: scale(0.62), iframe design width = canvas_w / 0.62.
//     canvas-x → iframe-x needs `/ 0.62`.
//
// Scripts that pass worldToScreen output STRAIGHT to hud_update render
// world-anchored elements (HP bars, damage numbers, speech bubbles, name
// tags) at the wrong screen pixel — drifted away from where the entity
// is. Reference good pattern: entity_health_bars.ts (branches on
// (pointer: coarse) for the right multiplier).
(function checkWorldToScreenScale() {
    var warnings = [];
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];
        if (ENGINE_MACHINERY_RE.test(scriptKey)) continue;
        // Trigger only when both: worldToScreen IS called AND a payload
        // is emitted via hud_update somewhere in the same script. A
        // script that uses worldToScreen for a non-HUD purpose (distance
        // gate, debug log) and never emits hud_update at all stays clean.
        if (!/\bworldToScreen\s*\(/.test(source)) continue;
        if (!/hud_update/.test(source)) continue;
        // Require BOTH branches: a desktop / non-responsive multiplier
        // (typically `1920 / canvas_w` keyed by a `.viewport-canvas-
        // container canvas` query OR the html_ui_manager `currentZoom`
        // field) AND a mobile pp-responsive multiplier (typically
        // `1 / 0.62`, keyed by either the `(pointer: coarse)`
        // mediaquery or a literal `0.62`). If a script handles only
        // one branch the other platform drifts — the dialogue-bubble
        // bug bit on desktop first, then the mobile fix landed but a
        // desktop-only fix was the regression. Token-set match means
        // we don't have to introspect call sites; either token's
        // presence reliably indicates the author thought about that
        // platform's scale.
        var hasMobileBranch = /pointer:\s*coarse/.test(source) || /0\.62/.test(source);
        var hasDesktopBranch = /viewport-canvas-container/.test(source) ||
                               /1920\s*\//.test(source) ||
                               /currentZoom/.test(source);
        if (hasMobileBranch && hasDesktopBranch) continue;
        warnings.push(scriptKey + (
            hasMobileBranch ? ' (mobile branch only)' :
            hasDesktopBranch ? ' (desktop branch only)' :
            ' (no scale compensation)'
        ));
    }
    if (warnings.length > 0) {
        console.error(
            'World-to-HUD scale check failed: ' + warnings.length + ' script(s) ' +
            'pass scene.worldToScreen output to hud_update without compensating for ' +
            'the HUD iframe\'s CSS scale. World-anchored HUD elements (HP bars, name ' +
            'tags, speech bubbles, damage numbers) will drift off the entity on any ' +
            'non-1920px viewport — and badly off-target on mobile, where pp-responsive ' +
            'panels use a hardcoded 0.62x scale (1920/390 ≈ 4.9, but the right ' +
            'multiplier is 1/0.62 ≈ 1.6). ' +
            'Affected: ' + warnings.join(', ') + '. ' +
            'Reference good pattern: branch on (pointer: coarse) for the mobile ' +
            'multiplier (1/0.62), fall through to the legacy canvas_w/1920 path on ' +
            'desktop. See entity_health_bars.ts in the library for an exact template.'
        );
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 16. Stale guard flag — script owns modal lifecycle but ignores close
// ═════════════════════════════════════════════════════════════════════
// If a FSM substate has BOTH a ui_event:<panel>:close exit AND a
// game_event:<Y> exit, and the script that emits the entry game_event
// also emits <Y> (proving it owns the lifecycle), it MUST also listen
// for ui_event:<panel>:close. Otherwise, closing the modal via the UI
// button leaves the script's guard flag set and blocks re-interaction.
(function() {
    if (!flow || !flow.states) return;

    // Collect substates with both close + game_event exits, plus what
    // game_event enters them (from sibling transitions).
    var candidates = []; // { state, closeEvent, gameExit, entryEvent }

    function findEntryEvents(substates) {
        // Map: stateName → list of game_events that transition INTO it
        var entryMap = {};
        var names = Object.keys(substates);
        for (var ni = 0; ni < names.length; ni++) {
            var sName = names[ni];
            var transitions = substates[sName].transitions || [];
            for (var ti = 0; ti < transitions.length; ti++) {
                var when = transitions[ti].when || '';
                var goto_ = transitions[ti]['goto'] || '';
                if (when.indexOf('game_event:') === 0 && goto_) {
                    if (!entryMap[goto_]) entryMap[goto_] = [];
                    entryMap[goto_].push(when.replace('game_event:', ''));
                }
            }
        }
        return entryMap;
    }

    function walkForCandidates(states) {
        var stateNames = Object.keys(states);
        for (var si = 0; si < stateNames.length; si++) {
            var st = states[stateNames[si]];
            if (st.substates) {
                var entryMap = findEntryEvents(st.substates);
                var subNames = Object.keys(st.substates);
                for (var ssi = 0; ssi < subNames.length; ssi++) {
                    var sub = st.substates[subNames[ssi]];
                    var transitions = sub.transitions || [];
                    var closeExits = [];
                    var gameExits = [];
                    for (var ti = 0; ti < transitions.length; ti++) {
                        var when = transitions[ti].when || '';
                        if (when.indexOf('ui_event:') === 0 && when.indexOf(':close') > 0) {
                            closeExits.push(when);
                        } else if (when.indexOf('game_event:') === 0) {
                            gameExits.push(when.replace('game_event:', ''));
                        }
                    }
                    if (closeExits.length > 0 && gameExits.length > 0) {
                        var entries = entryMap[subNames[ssi]] || [];
                        for (var ei = 0; ei < entries.length; ei++) {
                            for (var ci = 0; ci < closeExits.length; ci++) {
                                candidates.push({
                                    state: subNames[ssi],
                                    closeEvent: closeExits[ci],
                                    gameExits: gameExits,
                                    entryEvent: entries[ei]
                                });
                            }
                        }
                    }
                }
                walkForCandidates(st.substates);
            }
        }
    }
    walkForCandidates(flow.states);

    if (candidates.length === 0) return;

    // For each candidate, find the script that emits the entry event AND
    // one of the game exits. If it doesn't listen for the close event, error.
    var errors = [];
    var scriptEntries = Object.entries(allScripts);
    for (var ci = 0; ci < candidates.length; ci++) {
        var cand = candidates[ci];
        var entryRe = new RegExp('emit\\s*\\(\\s*["\']' + cand.entryEvent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']');
        var closeListenRe = new RegExp('on\\s*\\(\\s*["\']' + cand.closeEvent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']');

        for (var sei = 0; sei < scriptEntries.length; sei++) {
            var scriptKey = scriptEntries[sei][0];
            var source = scriptEntries[sei][1];
            if (ENGINE_MACHINERY_RE.test(scriptKey)) continue;
            if (!entryRe.test(source)) continue;
            // Script emits the entry event. Does it also emit one of the game exits?
            var ownsExit = false;
            for (var ge = 0; ge < cand.gameExits.length; ge++) {
                var exitRe = new RegExp('emit\\s*\\(\\s*["\']' + cand.gameExits[ge].replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '["\']');
                if (exitRe.test(source)) { ownsExit = true; break; }
            }
            if (!ownsExit) continue;
            // Script owns both entry and exit. Does it listen for the close event?
            if (!closeListenRe.test(source)) {
                errors.push(
                    scriptKey + ': emits "' + cand.entryEvent + '" (enters FSM state "' +
                    cand.state + '") and emits the resolution event, but does not handle "' +
                    cand.closeEvent + '". When the user closes the modal via the UI button, ' +
                    'internal guard flags (like _activeQuestion) stay set and block future ' +
                    'interactions. Add a listener: this.scene.events.ui.on("' +
                    cand.closeEvent + '", function() { self._clear...; });'
                );
            }
        }
    }
    if (errors.length > 0) {
        console.error('Stale guard flag: ' + errors.length + ' error(s). ' + errors[0]);
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 17. MP UI panel consistency — voice_chat, text_chat, ping
// ═════════════════════════════════════════════════════════════════════
// These three engine-owned panels are multiplayer infrastructure.
// Multiplayer games must show all three; single-player games must not
// show any of them.
(function() {
    if (!flow || !flow.states) return;

    var MP_PANELS = ['hud/voice_chat', 'hud/text_chat', 'hud/ping'];
    var found = {};
    for (var i = 0; i < MP_PANELS.length; i++) found[MP_PANELS[i]] = false;

    // Walk all actions in all states looking for show_ui: references
    function walkActions(states) {
        var names = Object.keys(states);
        for (var ni = 0; ni < names.length; ni++) {
            var st = states[names[ni]];
            var actions = [].concat(st.on_enter || [], st.on_exit || [], st.on_update || []);
            for (var ai = 0; ai < actions.length; ai++) {
                var a = String(actions[ai]);
                if (a.indexOf('show_ui:') === 0) {
                    var panel = a.slice(8);
                    if (found.hasOwnProperty(panel)) found[panel] = true;
                }
            }
            if (st.substates) walkActions(st.substates);
        }
    }
    walkActions(flow.states);

    var present = MP_PANELS.filter(function(p) { return found[p]; });
    var missing = MP_PANELS.filter(function(p) { return !found[p]; });

    if (mpEnabled && missing.length > 0) {
        console.error(
            'MP UI panel mismatch: game is multiplayer but missing show_ui for: ' +
            missing.map(function(p) { return '"' + p + '"'; }).join(', ') + '. ' +
            'Multiplayer games must show all three (voice_chat, text_chat, ping). ' +
            'Add show_ui:' + missing[0] + ' to your gameplay state\'s on_enter.'
        );
        process.exit(1);
    }
    if (!mpEnabled && present.length > 0) {
        console.error(
            'MP UI panel mismatch: game is single-player but shows MP-only panels: ' +
            present.map(function(p) { return '"' + p + '"'; }).join(', ') + '. ' +
            'Either make the game multiplayer (add "multiplayer": { "enabled": true, ... } ' +
            'to 01_flow.json) or remove the show_ui:' + present[0] + ' actions from the flow.'
        );
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 18. MP lobby flow wiring — mp_bridge active + lobby gate transition
// ═════════════════════════════════════════════════════════════════════
// A multiplayer game must (a) keep mp_bridge in some state's
// active_systems so MP events fire, and (b) gate gameplay entry on
// mp_event:phase_in_game so a lobby state actually exists. Bug we hit:
// learning-quest-heroes had multiplayer.enabled=true and the lobby UI
// HTML files, but the FSM jumped main_menu → gameplay on a plain
// ui_event, so the lobby browser/room screens were never reached and
// no remote players ever joined. Every shipping MP template (14 of
// them) follows this pattern; if mpEnabled and either piece is
// missing, the FSM is broken even though show_ui:hud/voice_chat etc.
// look right (caught by section 17).
(function() {
    if (!mpEnabled || !flow || !flow.states) return;

    var hasMpBridge = false;
    var hasPhaseInGame = false;

    function walk(states) {
        var names = Object.keys(states);
        for (var ni = 0; ni < names.length; ni++) {
            var st = states[names[ni]];
            var as = st.active_systems || [];
            for (var i = 0; i < as.length; i++) {
                if (String(as[i]) === 'mp_bridge') hasMpBridge = true;
            }
            var ts = st.transitions || [];
            for (var ti = 0; ti < ts.length; ti++) {
                var w = String(ts[ti].when || '');
                if (w.indexOf('mp_event:phase_in_game') === 0) hasPhaseInGame = true;
            }
            if (st.substates) walk(st.substates);
        }
    }
    walk(flow.states);

    if (!hasMpBridge) {
        console.error(
            'MP flow wiring: multiplayer.enabled=true but no state lists "mp_bridge" ' +
            'in active_systems. Without mp_bridge running, no mp_event:* fires and the ' +
            'lobby UI never advances. Add "active_systems": ["mp_bridge", ...] to your ' +
            'main_menu, lobby_browser, lobby_room, and gameplay states (see template ' +
            'multiplayer_coin_grab/01_flow.json).'
        );
        process.exit(1);
    }
    if (!hasPhaseInGame) {
        console.error(
            'MP flow wiring: multiplayer.enabled=true but no transition uses ' +
            '"when": "mp_event:phase_in_game". The FSM is jumping straight into ' +
            'gameplay on a ui_event, skipping the host/join lobby. Insert ' +
            'lobby_browser and lobby_room states between main_menu and gameplay, ' +
            'and gate gameplay entry on mp_event:phase_in_game from lobby_room ' +
            '(see template multiplayer_coin_grab/01_flow.json).'
        );
        process.exit(1);
    }
})();


// ═════════════════════════════════════════════════════════════════════
// 18. heightmapTerrain validation
// ═════════════════════════════════════════════════════════════════════
// Mirrors the inline-terrain checks in level_assembler.ts so malformed
// terrain blocks (unknown layer refs, bad elevation shapes, missing
// path points) fail in-sandbox instead of slipping through to the real
// assembler at publish time.
(function() {
    var w = loadJSON('03_worlds.json');
    var ht = w && w.worlds && w.worlds[0] && w.worlds[0].heightmapTerrain;
    if (!ht || !ht.layers || !ht.size) return;
    var errors = [];

    if (!Array.isArray(ht.size) || ht.size.length !== 2 || ht.size[0] <= 0 || ht.size[1] <= 0) {
        errors.push('heightmapTerrain.size must be [width, depth] with positive values');
    }
    if (!Array.isArray(ht.layers) || ht.layers.length < 1 || ht.layers.length > 4) {
        errors.push('heightmapTerrain.layers must have 1-4 entries');
    }
    var layerNames = {};
    if (Array.isArray(ht.layers)) {
        for (var li = 0; li < ht.layers.length; li++) {
            var L = ht.layers[li];
            if (!L.name || !L.dir) {
                errors.push('heightmapTerrain layer missing "name" or "dir": ' + JSON.stringify(L));
            } else {
                layerNames[L.name] = true;
            }
            if (typeof L.uvMetersPerTile !== 'number' || L.uvMetersPerTile <= 0) {
                errors.push('heightmapTerrain layer "' + L.name + '": uvMetersPerTile must be a positive number');
            }
        }
    }
    if (ht.default_layer && !layerNames[ht.default_layer]) {
        errors.push('heightmapTerrain.default_layer "' + ht.default_layer + '" not found in layers');
    }
    var paints = ht.paints || [];
    for (var pi = 0; pi < paints.length; pi++) {
        if (!layerNames[paints[pi].layer]) {
            errors.push('heightmapTerrain paint references unknown layer "' + paints[pi].layer + '"');
        }
    }
    var paths = ht.paths || [];
    for (var pi2 = 0; pi2 < paths.length; pi2++) {
        if (!layerNames[paths[pi2].layer]) {
            errors.push('heightmapTerrain path references unknown layer "' + paths[pi2].layer + '"');
        }
        if (!Array.isArray(paths[pi2].points) || paths[pi2].points.length < 2) {
            errors.push('heightmapTerrain path must have at least 2 points');
        }
    }

    // Elevation block (optional). Same checks as level_assembler.
    var ev = ht.elevation;
    if (ev) {
        if (typeof ev !== 'object' || Array.isArray(ev)) {
            errors.push('heightmapTerrain.elevation must be an object');
        } else {
            if (ev.resolution !== undefined && (typeof ev.resolution !== 'number' || ev.resolution < 32 || ev.resolution > 512)) {
                errors.push('heightmapTerrain.elevation.resolution must be a number 32-512');
            }
            if (ev.max_height !== undefined && (typeof ev.max_height !== 'number' || ev.max_height <= 0)) {
                errors.push('heightmapTerrain.elevation.max_height must be a positive number');
            }
            if (ev.noise) {
                if (typeof ev.noise !== 'object') errors.push('heightmapTerrain.elevation.noise must be an object');
                else if (typeof ev.noise.amplitude !== 'number' || ev.noise.amplitude < 0) {
                    errors.push('heightmapTerrain.elevation.noise.amplitude must be a non-negative number');
                }
            }
            var hills = ev.hills || [];
            for (var hi = 0; hi < hills.length; hi++) {
                var H = hills[hi];
                if (H.shape !== 'circle' && H.shape !== 'rect') {
                    errors.push('heightmapTerrain.elevation.hills[].shape must be "circle" or "rect" (got "' + H.shape + '")');
                }
                if (typeof H.height !== 'number') {
                    errors.push('heightmapTerrain.elevation.hills[].height must be a number (negative = depression)');
                }
                if (!Array.isArray(H.center) || H.center.length !== 2) {
                    errors.push('heightmapTerrain.elevation.hills[].center must be [x, z]');
                }
            }
            var fzs = ev.flat_zones || [];
            for (var zi = 0; zi < fzs.length; zi++) {
                var Z = fzs[zi];
                if (Z.shape !== 'circle' && Z.shape !== 'rect') {
                    errors.push('heightmapTerrain.elevation.flat_zones[].shape must be "circle" or "rect" (got "' + Z.shape + '")');
                }
                if (!Array.isArray(Z.center) || Z.center.length !== 2) {
                    errors.push('heightmapTerrain.elevation.flat_zones[].center must be [x, z]');
                }
            }
        }
    }

    if (errors.length > 0) {
        console.error('heightmapTerrain validation failed:');
        for (var ei = 0; ei < errors.length; ei++) console.error('  - ' + errors[ei]);
        process.exit(1);
    }
})();


console.log('Assembler check passed (' + Object.keys(allScripts).length + ' scripts, ' + Object.keys(uiFiles).length + ' UI panels checked).');
