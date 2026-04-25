// also: NPC behaviors, strategy AI, faction relations, negotiations, turn-based
// Diplomacy AI — AI civilization turn processing: build, train, expand, attack
class DiplomacyAISystem extends GameScript {
    _aiPersonality = "balanced";
    _aggressionThreshold = 1.5;
    _expansionPriority = 0.6;
    _sciencePriority = 0.7;
    _militaryPriority = 0.8;
    _peaceTurnsCooldown = 15;
    _warDeclarationMinTurns = 20;
    _buildPriority = [];
    _trainPriority = [];
    _attackWaveMinSize = 3;
    _scoutFrequency = 10;
    _tradeRouteValue = 5;
    _diplomacyStates = [];
    _warDeclareSound = "";
    _peaceDeclareSound = "";
    _tradeSound = "";

    // State
    _aiState = "peace";
    _turnsSinceWar = 0;
    _aiGold = 50;
    _aiScience = 3;
    _aiMilitary = 0;
    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._gameActive = true;
            self._aiState = "peace";
            self._turnsSinceWar = 0;
            self._aiGold = 50;
            self._publishHud();
        });

        this.scene.events.game.on("ai_turn_start", function() {
            self._processAITurn();
        });

        // Click-driven diplomacy.
        this.scene.events.ui.on("ui_event:hud/diplomacy_btn:declare_war", function() {
            if (self._aiState !== "war") {
                self._aiState = "war";
                self._turnsSinceWar = 0;
                if (self.audio) self.audio.playSound(self._warDeclareSound || "/assets/kenney/audio/sci_fi_sounds/forceField_001.ogg", 0.5);
                self._publishHud();
            }
        });
        this.scene.events.ui.on("ui_event:hud/diplomacy_btn:propose_peace", function() {
            if (self._aiState !== "peace") {
                self._aiState = "peace";
                self._turnsSinceWar = 0;
                if (self.audio) self.audio.playSound(self._peaceDeclareSound || "/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.5);
                self._publishHud();
            }
        });
    }

    _publishHud() {
        this.scene.events.ui.emit("hud_update", {
            aiState: this._aiState,
            aiMilitary: this._aiMilitary
        });
    }

    _processAITurn() {
        if (!this._gameActive) return;

        this._turnsSinceWar++;

        // Count AI entities
        var aiUnits = this.scene.findEntitiesByTag("unit") || [];
        var aiMil = [];
        for (var u = 0; u < aiUnits.length; u++) {
            if (!aiUnits[u].active) continue;
            var tags = aiUnits[u].tags || [];
            for (var t = 0; t < tags.length; t++) {
                if (tags[t] === "ai") { aiMil.push(aiUnits[u]); break; }
            }
        }
        this._aiMilitary = aiMil.length;

        // Count player military for aggression check
        var playerMil = 0;
        for (var u = 0; u < aiUnits.length; u++) {
            if (!aiUnits[u].active) continue;
            var tags = aiUnits[u].tags || [];
            for (var t = 0; t < tags.length; t++) {
                if (tags[t] === "player") { playerMil++; break; }
            }
        }

        // AI gold income
        var aiCities = this.scene.findEntitiesByTag("city") || [];
        var aiCityCount = 0;
        for (var c = 0; c < aiCities.length; c++) {
            if (!aiCities[c].active) continue;
            var ctags = aiCities[c].tags || [];
            for (var t = 0; t < ctags.length; t++) {
                if (ctags[t] === "ai") { aiCityCount++; break; }
            }
        }
        this._aiGold += aiCityCount * 3 + this._tradeRouteValue;

        // Decide aggression
        if (this._aiState === "peace" && this._turnsSinceWar >= this._warDeclarationMinTurns) {
            var ratio = playerMil > 0 ? this._aiMilitary / playerMil : 2;
            if (ratio >= this._aggressionThreshold) {
                this._aiState = "war";
                this._turnsSinceWar = 0;
                if (this.audio) this.audio.playSound(this._warDeclareSound || "/assets/kenney/audio/sci_fi_sounds/forceField_001.ogg", 0.5);
            }
        }

        // Move AI military units toward player if at war
        if (this._aiState === "war" && aiMil.length >= this._attackWaveMinSize) {
            // Find player capital position
            var playerCaps = this.scene.findEntitiesByTag("capital") || [];
            var targetX = 0, targetZ = 0;
            for (var c = 0; c < playerCaps.length; c++) {
                if (!playerCaps[c].active) continue;
                var ctags = playerCaps[c].tags || [];
                for (var t = 0; t < ctags.length; t++) {
                    if (ctags[t] === "player") {
                        var cp = playerCaps[c].transform.position;
                        targetX = cp.x;
                        targetZ = cp.z;
                        break;
                    }
                }
            }

            // Send units toward player
            for (var m = 0; m < aiMil.length; m++) {
                var mtags = aiMil[m].tags || [];
                var isMilitary = false;
                for (var t = 0; t < mtags.length; t++) { if (mtags[t] === "military") isMilitary = true; }
                if (!isMilitary) continue;

                var pos = aiMil[m].transform.position;
                var dx = targetX - pos.x + (Math.random() - 0.5) * 8;
                var dz = targetZ - pos.z + (Math.random() - 0.5) * 8;
                this.scene.events.game.emit("ai_move_unit", {
                    entityId: aiMil[m].id,
                    x: pos.x + dx * 0.15,
                    z: pos.z + dz * 0.15
                });

                // Check if near player units — attack
                for (var u = 0; u < aiUnits.length; u++) {
                    if (!aiUnits[u].active) continue;
                    var utags = aiUnits[u].tags || [];
                    var isPlayer = false;
                    for (var t = 0; t < utags.length; t++) { if (utags[t] === "player") isPlayer = true; }
                    if (!isPlayer) continue;
                    var up = aiUnits[u].transform.position;
                    var combatDist = Math.sqrt((pos.x - up.x) * (pos.x - up.x) + (pos.z - up.z) * (pos.z - up.z));
                    if (combatDist < 5) {
                        this.scene.events.game.emit("attack_unit", { attackerId: aiMil[m].id, defenderId: aiUnits[u].id });
                        break;
                    }
                }
            }
        }

        this.scene.events.ui.emit("hud_update", {
            aiState: this._aiState,
            aiMilitary: this._aiMilitary
        });
    }

    onUpdate(dt) {}
}
