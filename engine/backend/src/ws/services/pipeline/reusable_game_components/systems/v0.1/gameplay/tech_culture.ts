// also: research, progression, era, civilization, unlocks
// Tech and culture — technology research tree with era gating, culture policies
class TechCultureSystem extends GameScript {
    _technologies = {};
    _culturePolicies = {};
    _researchSound = "";
    _techCompleteSound = "";
    _policySound = "";

    // State
    _researched = [];
    _currentTech = "";
    _researchProgress = 0;
    _adoptedPolicies = [];
    _culturePool = 0;
    _gameActive = false;

    onStart() {
        var self = this;
        // Seed defensively — game_ready fires before this substate's
        // systems boot, so the handler below races (see 5a29bbe).
        this._reset();
        this.scene.events.game.on("game_ready", function() { self._reset(); });
        this.scene.events.game.on("turn_start", function() { self._processTechTurn(); });

        // Click-driven research / policy selection.
        this.scene.events.ui.on("ui_event:hud/tech_btn:select_tech", function(d) {
            var p = ((d && d.data) || {}).payload || {};
            if (p.techId) self._startResearch(p.techId);
            self._updateHud();
        });
        this.scene.events.ui.on("ui_event:hud/tech_btn:adopt_policy", function(d) {
            var p = ((d && d.data) || {}).payload || {};
            if (p.policyId) self._adoptPolicy(p.policyId);
        });

        this._reset();
    }

    _reset() {
        this._researched = [];
        this._currentTech = "";
        this._researchProgress = 0;
        this._adoptedPolicies = [];
        this._culturePool = 0;
        this._gameActive = true;
        this.scene._techsResearched = 0;

        // Auto-select first tech
        var techIds = Object.keys(this._technologies);
        for (var i = 0; i < techIds.length; i++) {
            var t = this._technologies[techIds[i]];
            if (t.era === "ancient" && (!t.prereqs || t.prereqs.length === 0)) {
                this._currentTech = techIds[i];
                break;
            }
        }
        this._updateHud();
    }

    _processTechTurn() {
        if (!this._gameActive || !this._currentTech) return;

        // Accumulate science toward current tech
        var sciPerTurn = this.scene._civScience || 3;
        this._researchProgress += sciPerTurn;

        var tech = this._technologies[this._currentTech];
        if (tech && this._researchProgress >= tech.cost) {
            // Tech completed!
            this._researched.push(this._currentTech);
            this._researchProgress = 0;
            this.scene._techsResearched = this._researched.length;

            if (this.audio) this.audio.playSound(this._techCompleteSound || "/assets/kenney/audio/digital_audio/powerUp4.ogg", 0.5);

            // Auto-select next available tech
            this._currentTech = this._findNextTech();
        }

        // Culture accumulation
        var culturePerTurn = this.scene._civCulture || 1;
        this._culturePool += culturePerTurn;

        this._updateHud();
    }

    _startResearch(techId) {
        if (this._researched.indexOf(techId) >= 0) return;
        var tech = this._technologies[techId];
        if (!tech) return;
        // Check prereqs
        if (tech.prereqs) {
            for (var p = 0; p < tech.prereqs.length; p++) {
                if (this._researched.indexOf(tech.prereqs[p]) < 0) return;
            }
        }
        this._currentTech = techId;
        this._researchProgress = 0;
        if (this.audio) this.audio.playSound(this._researchSound || "/assets/kenney/audio/rpg_audio/bookOpen.ogg", 0.4);
    }

    _findNextTech() {
        var techIds = Object.keys(this._technologies);
        for (var i = 0; i < techIds.length; i++) {
            if (this._researched.indexOf(techIds[i]) >= 0) continue;
            var t = this._technologies[techIds[i]];
            var prereqsMet = true;
            if (t.prereqs) {
                for (var p = 0; p < t.prereqs.length; p++) {
                    if (this._researched.indexOf(t.prereqs[p]) < 0) { prereqsMet = false; break; }
                }
            }
            if (prereqsMet) return techIds[i];
        }
        return "";
    }

    _adoptPolicy(policyId) {
        if (this._adoptedPolicies.indexOf(policyId) >= 0) return;
        var policy = this._culturePolicies[policyId];
        if (!policy) return;
        if (this._culturePool < policy.cost) return;
        this._culturePool -= policy.cost;
        this._adoptedPolicies.push(policyId);
        if (this.audio) this.audio.playSound(this._policySound || "/assets/kenney/audio/rpg_audio/metalClick.ogg", 0.4);
        this._updateHud();
    }

    _updateHud() {
        var techCost = 0;
        if (this._currentTech && this._technologies[this._currentTech]) {
            techCost = this._technologies[this._currentTech].cost;
        }

        // Build a list of available (researchable) techs so the HUD can
        // render clickable cards. A tech is researchable if not yet done
        // and its prereqs are all in the researched set.
        var techIds = Object.keys(this._technologies);
        var techList = [];
        for (var i = 0; i < techIds.length; i++) {
            var id = techIds[i];
            var t = this._technologies[id];
            var done = this._researched.indexOf(id) >= 0;
            var prereqsMet = true;
            if (t.prereqs) {
                for (var p = 0; p < t.prereqs.length; p++) {
                    if (this._researched.indexOf(t.prereqs[p]) < 0) { prereqsMet = false; break; }
                }
            }
            techList.push({
                id: id,
                era: t.era,
                cost: t.cost,
                done: done,
                researchable: !done && prereqsMet,
                isCurrent: id === this._currentTech,
                prereqs: t.prereqs || [],
                unlocks: t.unlocks || []
            });
        }

        var policyIds = Object.keys(this._culturePolicies);
        var policyList = [];
        for (var k = 0; k < policyIds.length; k++) {
            var pid = policyIds[k];
            var pol = this._culturePolicies[pid];
            policyList.push({
                id: pid,
                cost: pol.cost,
                effect: pol.effect,
                adopted: this._adoptedPolicies.indexOf(pid) >= 0,
                affordable: this._culturePool >= pol.cost
            });
        }

        this.scene.events.ui.emit("hud_update", {
            currentTech: this._currentTech,
            techProgress: this._researchProgress,
            techCost: techCost,
            techsResearched: this._researched.length,
            totalTechs: Object.keys(this._technologies).length,
            culturePool: Math.floor(this._culturePool),
            policiesAdopted: this._adoptedPolicies.length,
            techList: techList,
            policyList: policyList
        });
        // Share with other systems
        this.scene._civScience = this.scene._civScience || 3;
        this.scene._civCulture = this.scene._civCulture || 1;
    }

    onUpdate(dt) {}
}
