// validate_assembler_script.js — Strict assembler validation.
//
// Runs the exact same validation checks as assembleGame() in
// level_assembler.ts, entirely offline using the sandbox's project/
// directory. Replaces the HTTP-based approach that soft-failed when
// the backend was unreachable (e.g. Docker on remote workers).
//
// The 8 validation categories, checked in order (first failure exits):
//   1. Event validation — unknown game events, wrong bus, missing payload fields
//   2. Reference validation — missing behavior/system files, missing UI panels
//   3. FSM structural — missing start fields, unknown active_behaviors/systems
//   4. spawnEntity — unknown entity definition references
//   5. UI button — ui_event transitions referencing missing panel buttons
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
(function() {
    var validPrefabs = new Set(Object.keys(defs));
    var spawnErrors = [];
    var scriptEntries = Object.entries(allScripts);
    for (var sei = 0; sei < scriptEntries.length; sei++) {
        var scriptKey = scriptEntries[sei][0];
        var source = scriptEntries[sei][1];
        for (var m of source.matchAll(/\.spawnEntity\s*\(\s*['"]([^'"]+)['"]/g)) {
            if (!validPrefabs.has(m[1])) {
                var valid = Array.from(validPrefabs).sort().join(', ') || '(none)';
                spawnErrors.push(
                    scriptKey + ': spawnEntity("' + m[1] + '") references unknown entity definition. Valid names: ' + valid
                );
            }
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
                    hudErrors.push(
                        scriptKey + ': hud_update key "' + keys[ki] + '" collides with an FSM-reserved state key. ' +
                        'Reserved names: ' + Array.from(reservedKeys).sort().join(', ')
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
// asset directory. Every path in an entity def's mesh.asset or a
// script's playSound/playMusic must appear in the catalog, otherwise
// the runtime will silently fail (invisible meshes, no audio).
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

    // Skip if no catalogs found (offline/self-hosted dev without assets)
    if (allAssets.size === 0) {
        console.log('Assembler check passed (' + Object.keys(allScripts).length + ' scripts, ' + Object.keys(uiFiles).length + ' UI panels checked).');
        process.exit(0);
    }

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

    if (assetErrors.length > 0) {
        console.error('Asset validation failed: ' + assetErrors.length + ' missing asset(s). ' + assetErrors[0]);
        process.exit(1);
    }
})();


console.log('Assembler check passed (' + Object.keys(allScripts).length + ' scripts, ' + Object.keys(uiFiles).length + ' UI panels checked).');
