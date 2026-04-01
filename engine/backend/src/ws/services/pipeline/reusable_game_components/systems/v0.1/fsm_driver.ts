// Universal FSM Driver — executes FSM configs on a single entity.
// Written in plain JS (no TypeScript annotations).
//
// Event format in transitions: "game_event:xxx", "ui_event:panel:action", "keyboard:action"
// Event format in "on" handlers: "bus.eventName" (e.g. "game.entity_killed", "ui.cursor_click")

class FSMDriver extends GameScript {
    _fsmConfigs = "[]";
    _subscribes = "[]";
    _instances = [];
    _initialized = false;
    _handlingEvent = false;

    onStart() {
        var self = this;
        var configs;
        try { configs = JSON.parse(this._fsmConfigs); } catch(e) { configs = []; }

        for (var i = 0; i < configs.length; i++) {
            var cfg = configs[i];
            if (!cfg || !cfg.states) continue;
            var inst = new FSMInst(cfg, this.scene, this.entity, this.ui);
            inst.activate();
            this._instances.push(inst);
        }

        // Auto-collect all events from configs (transitions + "on" handlers)
        var allEvents = {};
        for (var fi = 0; fi < this._instances.length; fi++) {
            var instCfg = this._instances[fi]._cfg;
            // "on" handlers use bus.eventName format
            var onH = instCfg.on || {};
            for (var ev in onH) { allEvents[ev] = true; }
            // Transitions use game_event:, ui_event:, keyboard: prefixes
            this._collectTransitionEvents(instCfg.states || {}, allEvents);
        }

        // Subscribe to events on typed buses
        for (var evName in allEvents) {
            (function(eName) {
                var dotIdx = eName.indexOf(".");
                if (dotIdx <= 0) return;
                var busName = eName.substring(0, dotIdx);
                var eventKey = eName.substring(dotIdx + 1);
                var bus = self.scene.events[busName];
                if (!bus) return;
                try { bus.on(eventKey, function(data) {
                    if (self._handlingEvent) return;
                    self._handlingEvent = true;
                    for (var ii = 0; ii < self._instances.length; ii++) {
                        if (self._instances[ii]._active) {
                            self._instances[ii].handleEvent(eName, data);
                        }
                    }
                    self._handlingEvent = false;
                }); } catch(e) {}
            })(evName);
        }

        this._initialized = true;
    }

    _collectTransitionEvents(states, allEvents) {
        for (var sn in states) {
            var st = states[sn];
            if (st.transitions) {
                for (var ti = 0; ti < st.transitions.length; ti++) {
                    var w = st.transitions[ti].when || "";
                    if (!w || w === "timer_expired" || w === "random" || w.indexOf("random:") === 0) continue;
                    if (w.indexOf(">") >= 0 || w.indexOf("<") >= 0 || w.indexOf("=") >= 0 || w.indexOf("!") >= 0) continue;
                    // bus.eventName format
                    if (w.indexOf(".") >= 0) { allEvents[w] = true; continue; }
                    // game_event:xxx → subscribe on game bus
                    if (w.indexOf("game_event:") === 0) { allEvents["game." + w.substring(11)] = true; continue; }
                    // ui_event:panel:action or keyboard:action → subscribe on ui bus
                    if (w.indexOf(":") >= 0) { allEvents["ui." + w] = true; continue; }
                }
            }
            if (st.substates) this._collectTransitionEvents(st.substates, allEvents);
        }
    }

    onUpdate(dt) {
        if (!this._initialized) return;
        for (var i = 0; i < this._instances.length; i++) {
            if (this._instances[i]._active) {
                this._instances[i].tick(dt);
            }
        }
        // Emit merged FSM state for UI bridge
        if (this._instances.length > 0) {
            var merged = {};
            for (var i = 0; i < this._instances.length; i++) {
                var inst = this._instances[i];
                if (!inst._active) continue;
                for (var k in inst._vars) {
                    if (merged[k] === undefined) merged[k] = inst._vars[k];
                }
                if (!merged.phase && inst._state) merged.phase = inst._state;
            }
            this.scene.events.game.emit("state_changed", merged);
        }
    }
}

// ─── FSM Instance ───────────────────────────────────────────────────────────

class FSMInst {
    constructor(cfg, scene, entity, ui) {
        this._cfg = cfg;
        this._scene = scene;
        this._entity = entity;
        this._ui = ui;
        this._uiParams = cfg._uiParams || null;
        this._state = "";
        this._prevState = "";
        this._substate = null;
        this._activeSubstates = null;
        this._timer = 0;
        this._subTimer = 0;
        this._vars = {};
        this._totalTime = 0;
        this._stateHistory = [];
        this._transitionDelays = {};
        this._eventFlags = [];
        this._active = false;

        if (cfg.vars) {
            for (var k in cfg.vars) this._vars[k] = cfg.vars[k];
        }
    }

    activate() {
        if (this._active) return;
        this._active = true;
        if (this._cfg.start && this._cfg.states && this._cfg.states[this._cfg.start]) {
            this._enterState(this._cfg.start);
        }
    }

    // ─── State management ───────────────────────────────────────────────

    _enterState(name) {
        var states = this._cfg.states;
        if (!states || !states[name]) return;
        var s = states[name];
        // Exit old state
        if (this._state && this._state !== name) {
            this._stateHistory.push(this._state);
            if (this._stateHistory.length > 50) this._stateHistory.shift();
            var oldState = states[this._state];
            if (oldState && oldState.on_exit) this._runActions(oldState.on_exit);
        }
        this._prevState = this._state;
        this._state = name;
        this._timer = 0;
        this._transitionDelays = {};
        this._activeSubstates = null;
        this._substate = null;
        // Activate systems + behaviors before on_enter
        if (s.active_systems) this._applySystems(s.active_systems);
        if (s.active_behaviors) this._applyBehaviors(s.active_behaviors);
        if (s.on_enter) this._runActions(s.on_enter);
        // Enter start substate
        if (s.substates && s.start && s.substates[s.start]) {
            this._activeSubstates = s.substates;
            this._enterSubstate(s.start);
        }
    }

    _enterSubstate(name) {
        var s = this._activeSubstates[name];
        if (!s) return;
        if (this._substate) {
            var oldSub = this._activeSubstates[this._substate];
            if (oldSub && oldSub.on_exit) this._runActions(oldSub.on_exit);
        }
        this._substate = name;
        this._subTimer = 0;
        if (s.active_systems) this._applySystems(s.active_systems);
        if (s.active_behaviors) this._applyBehaviors(s.active_behaviors);
        if (s.on_enter) this._runActions(s.on_enter);
    }

    _applySystems(systemList) {
        var scene = this._scene;
        if (!scene) return;
        var activeSet = {};
        for (var i = 0; i < systemList.length; i++) activeSet[systemList[i]] = true;
        var allEntities = scene.getAllEntities ? scene.getAllEntities() : [];
        for (var ei = 0; ei < allEntities.length; ei++) {
            var ent = allEntities[ei];
            var tags = ent.tags || [];
            var tagArr = typeof tags.forEach === "function" ? tags : [];
            tagArr.forEach(function(tag) {
                if (typeof tag === "string" && tag.indexOf("system_") === 0) {
                    var sysName = tag.substring(7);
                    // UI system is always active
                    if (sysName === "ui") { ent.active = true; return; }
                    ent.active = !!activeSet[sysName];
                }
            });
        }
        this._emitBus("game", "active_systems", { systems: systemList });
    }

    _applyBehaviors(behaviorList) {
        this._emitBus("game", "active_behaviors", { behaviors: behaviorList });
    }

    // ─── Tick ───────────────────────────────────────────────────────────

    tick(dt) {
        this._totalTime += dt;
        this._timer += dt;
        var states = this._cfg.states;
        if (!states || !states[this._state]) return;
        var s = states[this._state];

        // Run on_update
        if (s.on_update) this._runActions(s.on_update);

        // Check transitions
        if (s.transitions) this._checkTransitions(s.transitions, false);

        // Tick substates
        if (this._activeSubstates && this._substate) {
            var sub = this._activeSubstates[this._substate];
            if (sub) {
                if (sub.on_update) this._runActions(sub.on_update);
                if (sub.transitions) this._checkTransitions(sub.transitions, true);
            }
            // Parent transitions can exit substates (e.g. pause)
            if (s.transitions) this._checkTransitions(s.transitions, false);
        }

        // Clear one-shot event flags
        for (var ef = 0; ef < this._eventFlags.length; ef++) {
            delete this._vars[this._eventFlags[ef]];
        }
        this._eventFlags.length = 0;
    }

    _checkTransitions(transitions, isSubstate) {
        for (var i = 0; i < transitions.length; i++) {
            var t = transitions[i];
            var when = t.when || "";
            // Random transitions
            if (when === "random") {
                var targets = t.goto;
                if (t.actions) this._runActions(t.actions);
                if (Array.isArray(targets)) {
                    this._enterState(targets[Math.floor(Math.random() * targets.length)]);
                } else if (targets) {
                    this._enterState(targets);
                }
                return;
            }
            if (when.indexOf("random:") === 0) {
                var chance = parseFloat(when.substring(7)) || 0.5;
                if (Math.random() < chance * (this._totalTime > 0.1 ? 0.016 : 0)) {
                    if (t.actions) this._runActions(t.actions);
                    var tgt = t.goto;
                    if (tgt) this._enterState(typeof tgt === "string" ? tgt : tgt[Math.floor(Math.random() * tgt.length)]);
                    return;
                }
                continue;
            }
            // Condition check
            if (this._checkCondition(when)) {
                if (t.actions) this._runActions(t.actions);
                if (t.goto) {
                    var target = typeof t.goto === "string" ? t.goto : t.goto[0];
                    if (isSubstate) {
                        this._enterSubstate(target);
                    } else {
                        if (this._activeSubstates) { this._activeSubstates = null; this._substate = null; }
                        this._enterState(target);
                    }
                }
                return;
            }
        }
    }

    // ─── Event handling ─────────────────────────────────────────────────

    handleEvent(eventName, data) {
        // Run "on" handlers
        var handlers = this._cfg.on;
        if (handlers && handlers[eventName]) {
            this._runActions(handlers[eventName], data);
        }
        // Set event flags for transition checking (cleared after tick)
        var dotIdx = eventName.indexOf(".");
        var shortName = dotIdx > 0 ? eventName.substring(dotIdx + 1) : eventName;
        this._vars[shortName] = 1;
        this._vars[eventName] = 1;
        this._eventFlags.push(shortName, eventName);
    }

    // ─── Condition checking ─────────────────────────────────────────────

    _checkCondition(cond) {
        if (!cond) return false;
        if (cond === "timer_expired") {
            var s = this._cfg.states[this._state];
            var d = (s && typeof s.duration === "number") ? s.duration : -1;
            return d > 0 && this._timer >= d;
        }
        // Variable comparison: "score>=100", "health<0", "round==3"
        var m = cond.match(/^(\w+)\s*(>=|<=|>|<|==|!=)\s*(.+)$/);
        if (m) {
            var lhs = this._vars[m[1]] || 0;
            var rhs = parseFloat(m[3]);
            if (!isNaN(rhs)) {
                if (m[2] === ">") return lhs > rhs;
                if (m[2] === "<") return lhs < rhs;
                if (m[2] === ">=") return lhs >= rhs;
                if (m[2] === "<=") return lhs <= rhs;
                if (m[2] === "==") return lhs == rhs;
                if (m[2] === "!=") return lhs != rhs;
            }
        }
        // Event flag: strip game_event: prefix since handleEvent stores bare name
        var checkKey = cond;
        if (cond.indexOf("game_event:") === 0) checkKey = cond.substring(11);
        return !!this._vars[checkKey];
    }

    // ─── Actions ────────────────────────────────────────────────────────

    _emitBus(busName, eventName, data) {
        var bus = this._scene.events[busName];
        if (bus) bus.emit(eventName, data);
    }

    _runActions(actions, eventData) {
        if (!actions) return;
        for (var i = 0; i < actions.length; i++) this._runAction(actions[i], eventData);
    }

    _runAction(action, eventData) {
        if (!action || typeof action !== "string") return;

        // ── State control ──
        if (action.indexOf("goto:") === 0) {
            var target = action.substring(5);
            if (target === "_back") {
                var prev = this._stateHistory.pop();
                if (prev) this._enterState(prev);
            } else {
                this._enterState(target);
            }
            return;
        }

        // ── Variables ──
        if (action.indexOf("set:") === 0) {
            var parts = action.substring(4).split("=");
            var val = parts[1];
            if (val && val.charAt(0) === "$" && eventData) {
                this._vars[parts[0]] = eventData[val.substring(1)] || 0;
            } else {
                var num = parseFloat(val);
                this._vars[parts[0]] = isNaN(num) ? val : num;
            }
            return;
        }
        if (action.indexOf("increment:") === 0) {
            var v = action.substring(10);
            this._vars[v] = (this._vars[v] || 0) + 1;
            return;
        }
        // Arithmetic: "score+10", "health-$damage"
        var am = action.match(/^(\w+)([+-])(.+)$/);
        if (am) {
            var varName = am[1];
            var sign = am[2] === "+" ? 1 : -1;
            var amtStr = am[3];
            var amt = (amtStr.charAt(0) === "$" && eventData) ? (parseFloat(eventData[amtStr.substring(1)]) || 0) : (parseFloat(amtStr) || 0);
            this._vars[varName] = (this._vars[varName] || 0) + sign * amt;
            if (varName === "score" && sign > 0) {
                this._emitBus("game", "add_score", { amount: amt });
            }
            return;
        }

        // ── Events ──
        if (action.indexOf("emit:") === 0) {
            var emitArg = action.substring(5);
            var dotIdx = emitArg.indexOf(".");
            if (dotIdx > 0) {
                this._emitBus(emitArg.substring(0, dotIdx), emitArg.substring(dotIdx + 1), eventData || {});
            }
            return;
        }

        // ── UI ──
        if (action.indexOf("show_ui:") === 0) {
            var panel = action.substring(8);
            this._emitBus("ui", "show_ui", { panel: panel });
            if (this._uiParams && this._uiParams[panel]) {
                this._emitBus("ui", "hud_update", this._uiParams[panel]);
            }
            return;
        }
        if (action.indexOf("hide_ui:") === 0) {
            this._emitBus("ui", "hide_ui", { panel: action.substring(8) });
            return;
        }
        if (action === "show_cursor") { this._emitBus("ui", "show_cursor", {}); return; }
        if (action === "hide_cursor") { this._emitBus("ui", "hide_cursor", {}); return; }
        if (action.indexOf("notify:") === 0) {
            this._emitBus("ui", "show_notification", { text: action.substring(7) });
            return;
        }

        // ── Audio ──
        if (action.indexOf("play_sound:") === 0) { this._emitBus("audio", "play_sound", { path: action.substring(11) }); return; }
        if (action.indexOf("play_music:") === 0) { this._emitBus("audio", "play_music", { path: action.substring(11) }); return; }
        if (action === "stop_music") { this._emitBus("audio", "stop_music", {}); return; }
        if (action === "stop_sound") { this._emitBus("audio", "stop_sound", {}); return; }

        // ── Timer ──
        if (action.indexOf("set_timer:") === 0) {
            this._timer = 0;
            return;
        }

        // ── Random action ──
        if (action.indexOf("random_action:") === 0) {
            var choices = action.substring(14).split(",");
            if (choices.length > 0) this._runAction(choices[Math.floor(Math.random() * choices.length)].trim(), eventData);
            return;
        }
    }
}
