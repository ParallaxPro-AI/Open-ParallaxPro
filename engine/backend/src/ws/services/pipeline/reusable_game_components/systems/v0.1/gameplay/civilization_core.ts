// also: tech tree, progression system, resource management, 4X gameplay, civilizations
// Civilization core — turn counter, resource yields, city growth, era progression, victory conditions
class CivilizationCoreSystem extends GameScript {
    _maxTurns = 150;
    _startGold = 50;
    _startFood = 10;
    _startProduction = 5;
    _startScience = 3;
    _startCulture = 1;
    _eras = ["ancient", "classical", "medieval", "renaissance"];
    _eraThresholds = [0, 4, 8, 12];
    _cityGrowthFood = 20;
    _cityBaseYields = { food: 2, production: 1, gold: 3 };
    _districtYields = {};
    _buildCosts = {};
    _victoryConditions = {};
    _turnSound = "";
    _buildCompleteSound = "";
    _eraAdvanceSound = "";
    _cityGrowthSound = "";

    // State
    _turn = 0;
    _gold = 50;
    _food = 10;
    _production = 5;
    _science = 3;
    _culture = 1;
    _era = "ancient";
    _eraIndex = 0;
    _gameActive = false;
    _playerCities = 0;
    _aiCities = 0;
    _playerUnits = 0;
    _aiUnits = 0;
    _selectedUnitIndex = -1;
    _playerUnitList = [];
    _foodAccum = 0;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() { self._fullReset(); });
        this.scene.events.game.on("turn_start", function() { self._processTurn(); });
        this.scene.events.game.on("entity_killed", function(data) {
            self._countEntities();
        });
        this._fullReset();
    }

    _fullReset() {
        this._turn = 0;
        this._gold = this._startGold;
        this._food = this._startFood;
        this._production = this._startProduction;
        this._science = this._startScience;
        this._culture = this._startCulture;
        this._era = this._eras[0];
        this._eraIndex = 0;
        this._gameActive = true;
        this._foodAccum = 0;
        this._countEntities();
        this._updateHud();
    }

    _processTurn() {
        if (!this._gameActive) return;
        this._turn++;

        // Calculate yields from cities
        var cities = this.scene.findEntitiesByTag("city") || [];
        var playerCityCount = 0;
        for (var c = 0; c < cities.length; c++) {
            if (!cities[c].active) continue;
            var tags = cities[c].tags || [];
            var isPlayer = false;
            for (var t = 0; t < tags.length; t++) { if (tags[t] === "player") isPlayer = true; }
            if (!isPlayer) continue;
            playerCityCount++;
            this._gold += this._cityBaseYields.gold;
            this._food += this._cityBaseYields.food;
            this._production += this._cityBaseYields.production;
        }
        this._playerCities = playerCityCount;

        // Calculate district yields
        var districts = this.scene.findEntitiesByTag("district") || [];
        for (var d = 0; d < districts.length; d++) {
            if (!districts[d].active) continue;
            var dtags = districts[d].tags || [];
            var dIsPlayer = false;
            for (var t = 0; t < dtags.length; t++) { if (dtags[t] === "player") dIsPlayer = true; }
            if (!dIsPlayer) continue;
            for (var t = 0; t < dtags.length; t++) {
                var yields = this._districtYields[dtags[t]];
                if (yields) {
                    if (yields.food) this._food += yields.food;
                    if (yields.production) this._production += yields.production;
                    if (yields.gold) this._gold += yields.gold;
                    if (yields.science) this._science += yields.science;
                    if (yields.culture) this._culture += yields.culture;
                }
            }
        }

        // City population growth
        this._foodAccum += Math.max(0, this._food - playerCityCount * 2);
        if (this._foodAccum >= this._cityGrowthFood && playerCityCount > 0) {
            this._foodAccum -= this._cityGrowthFood;
            if (this.audio) this.audio.playSound(this._cityGrowthSound || "/assets/kenney/audio/digital_audio/powerUp4.ogg", 0.4);
        }

        // Era progression (based on scene variable set by tech_culture)
        var techCount = this.scene._techsResearched || 0;
        for (var e = this._eras.length - 1; e >= 0; e--) {
            if (techCount >= this._eraThresholds[e] && e > this._eraIndex) {
                this._eraIndex = e;
                this._era = this._eras[e];
                if (this.audio) this.audio.playSound(this._eraAdvanceSound || "/assets/kenney/audio/digital_audio/powerUp12.ogg", 0.5);
                break;
            }
        }

        // Unit maintenance
        var pUnits = this.scene.findEntitiesByTag("unit") || [];
        var playerUnitCount = 0;
        for (var u = 0; u < pUnits.length; u++) {
            if (!pUnits[u].active) continue;
            var utags = pUnits[u].tags || [];
            for (var t = 0; t < utags.length; t++) {
                if (utags[t] === "player") { playerUnitCount++; break; }
            }
        }
        this._playerUnits = playerUnitCount;
        this._gold -= playerUnitCount; // 1 gold maintenance per unit

        // Victory check
        this._checkVictory();

        if (this.audio && this._turnSound) this.audio.playSound(this._turnSound, 0.3);
        this._updateHud();
    }

    _countEntities() {
        var cities = this.scene.findEntitiesByTag("city") || [];
        this._playerCities = 0;
        this._aiCities = 0;
        for (var c = 0; c < cities.length; c++) {
            if (!cities[c].active) continue;
            var tags = cities[c].tags || [];
            for (var t = 0; t < tags.length; t++) {
                if (tags[t] === "player") this._playerCities++;
                if (tags[t] === "ai") this._aiCities++;
            }
        }

        var units = this.scene.findEntitiesByTag("unit") || [];
        this._playerUnits = 0;
        this._aiUnits = 0;
        for (var u = 0; u < units.length; u++) {
            if (!units[u].active) continue;
            var utags = units[u].tags || [];
            for (var t = 0; t < utags.length; t++) {
                if (utags[t] === "player") this._playerUnits++;
                if (utags[t] === "ai") this._aiUnits++;
            }
        }
    }

    _checkVictory() {
        // Domination: all AI capitals destroyed
        var aiCapitals = this.scene.findEntitiesByTag("capital") || [];
        var aiCapAlive = false;
        for (var c = 0; c < aiCapitals.length; c++) {
            if (!aiCapitals[c].active) continue;
            var tags = aiCapitals[c].tags || [];
            for (var t = 0; t < tags.length; t++) {
                if (tags[t] === "ai") { aiCapAlive = true; break; }
            }
            if (aiCapAlive) break;
        }
        if (!aiCapAlive && this._turn > 1) {
            this.scene.events.game.emit("victory", {});
            this._gameActive = false;
            return;
        }

        // Player capital destroyed = defeat
        var playerCapitals = this.scene.findEntitiesByTag("capital") || [];
        var playerCapAlive = false;
        for (var c = 0; c < playerCapitals.length; c++) {
            if (!playerCapitals[c].active) continue;
            var tags = playerCapitals[c].tags || [];
            for (var t = 0; t < tags.length; t++) {
                if (tags[t] === "player") { playerCapAlive = true; break; }
            }
            if (playerCapAlive) break;
        }
        if (!playerCapAlive && this._turn > 1) {
            this.scene.events.game.emit("defeat", {});
            this._gameActive = false;
            return;
        }

        // Science victory: 14 techs
        if ((this.scene._techsResearched || 0) >= 14) {
            this.scene.events.game.emit("victory", {});
            this._gameActive = false;
            return;
        }

        // Turn limit
        if (this._turn >= this._maxTurns) {
            if (this._playerCities > this._aiCities) {
                this.scene.events.game.emit("victory", {});
            } else {
                this.scene.events.game.emit("defeat", {});
            }
            this._gameActive = false;
        }
    }

    onUpdate(dt) {
        // FSM membership in active_systems gates onUpdate already — the
        // _gameActive flag is still meaningful for _processTurn (we
        // don't want to advance turns after victory/defeat sets it
        // false), but as an onUpdate early-return it was redundant AND
        // a footgun: gameplay.on_enter emits game_ready and the
        // player_turn substate boots its systems AFTER, so onStart can
        // race the event. The fullReset in onStart handles the normal
        // case; we no longer block here.

        // Unit selection with Tab
        if (this.input.isKeyPressed("Tab")) {
            this._cycleUnit();
        }

        // Move selected unit with right-click or M key
        if (this.input.isKeyPressed("KeyM") && this._selectedUnitIndex >= 0) {
            // Move toward camera look target
            var camX = this.scene._stratCamX || 0;
            var camZ = this.scene._stratCamZ || 0;
            this.scene.events.game.emit("move_unit", { x: camX, z: camZ });
        }

        this._updateHud();
    }

    _cycleUnit() {
        var units = this.scene.findEntitiesByTag("unit") || [];
        var playerUnits = [];
        for (var u = 0; u < units.length; u++) {
            if (!units[u].active) continue;
            var tags = units[u].tags || [];
            for (var t = 0; t < tags.length; t++) {
                if (tags[t] === "player") { playerUnits.push(units[u]); break; }
            }
        }
        this._playerUnitList = playerUnits;
        if (playerUnits.length === 0) return;

        this._selectedUnitIndex = (this._selectedUnitIndex + 1) % playerUnits.length;
        var selected = playerUnits[this._selectedUnitIndex];
        this.scene.events.game.emit("select_unit", { entityId: selected.id });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_001.ogg", 0.3);
    }

    _updateHud() {
        this.scene.events.ui.emit("hud_update", {
            turn: this._turn,
            maxTurns: this._maxTurns,
            gold: this._gold,
            food: this._food,
            production: this._production,
            science: this._science,
            culture: this._culture,
            era: this._era,
            eraIndex: this._eraIndex,
            playerCities: this._playerCities,
            aiCities: this._aiCities,
            playerUnits: this._playerUnits,
            aiUnits: this._aiUnits,
            selectedUnit: this._selectedUnitIndex >= 0 && this._playerUnitList[this._selectedUnitIndex] ? this._playerUnitList[this._selectedUnitIndex].name : ""
        });
    }
}
