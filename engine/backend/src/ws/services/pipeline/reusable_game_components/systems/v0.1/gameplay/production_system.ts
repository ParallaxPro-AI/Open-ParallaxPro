// also: RTS construction, queue-based spawning, resource cost, building system, unit training
// Production system — click-driven unit training and building construction.
// Listens for ui_event:hud/command_panel:train_unit and :build_structure
// commands, deducts resources from the resource_system via shared events,
// and spawns the new entity near a player command_center. Keeps a small
// build queue so the HUD can show what's being trained.
class ProductionSystemInstance extends GameScript {
    _gameActive = false;

    // Cost: { minerals, gas, supply, build, kind }  (build = seconds)
    _unitCosts = {};
    _buildingCosts = {};

    // Local mirror of resources — we listen to resource_system's hud_update
    // to know what we can afford. Actual deduction is published back via
    // resource_request events.
    _minerals = 0;
    _gas = 0;
    _supply = 0;
    _supplyMax = 0;

    // Active builds: [{ kind: 'unit'|'structure', type, remaining, total }]
    _queue = [];

    onStart() {
        var s = this;

        this._unitCosts = {
            worker:        { minerals: 50,  gas: 0,   supply: 1, build: 4 },
            marine:        { minerals: 50,  gas: 0,   supply: 1, build: 5 },
            marine_female: { minerals: 50,  gas: 0,   supply: 1, build: 5 },
            medic:         { minerals: 75,  gas: 0,   supply: 1, build: 6 },
            ghost:         { minerals: 100, gas: 50,  supply: 2, build: 8 },
            tank:          { minerals: 150, gas: 50,  supply: 3, build: 10 },
            siege_tank:    { minerals: 200, gas: 100, supply: 4, build: 14 },
            mech_walker:   { minerals: 150, gas: 75,  supply: 3, build: 11 },
            battle_mech:   { minerals: 250, gas: 150, supply: 5, build: 16 },
            scout_mech:    { minerals: 100, gas: 25,  supply: 2, build: 7 }
        };

        this._buildingCosts = {
            barracks:        { minerals: 150, gas: 0,   build: 12 },
            factory:         { minerals: 200, gas: 100, build: 16 },
            mech_bay:        { minerals: 200, gas: 150, build: 18 },
            refinery:        { minerals: 100, gas: 0,   build: 10 },
            supply_depot:    { minerals: 100, gas: 0,   build: 8 },
            engineering_bay: { minerals: 125, gas: 0,   build: 10 },
            turret_cannon:   { minerals: 100, gas: 0,   build: 8 },
            turret_laser:    { minerals: 150, gas: 50,  build: 10 }
        };

        this.scene.events.game.on("game_ready", function() {
            s._gameActive = true;
            s._queue = [];
            s._publishHud();
        });

        // Mirror resource_system snapshots so we know what we can afford.
        this.scene.events.ui.on("hud_update", function(d) {
            if (!d) return;
            if (typeof d.minerals === "number") s._minerals = d.minerals;
            if (typeof d.gas === "number") s._gas = d.gas;
            if (typeof d.supply === "number") s._supply = d.supply;
            if (typeof d.supplyMax === "number") s._supplyMax = d.supplyMax;
        });

        // Click-driven training.
        this.scene.events.ui.on("ui_event:hud/command_panel:train_unit", function(d) {
            var p = ((d && d.data) || {}).payload || {};
            if (p.type) s._tryTrainUnit(p.type);
        });
        this.scene.events.ui.on("ui_event:hud/command_panel:build_structure", function(d) {
            var p = ((d && d.data) || {}).payload || {};
            if (p.type) s._tryBuildStructure(p.type);
        });
        this.scene.events.ui.on("ui_event:hud/command_panel:cancel_build", function(d) {
            var p = ((d && d.data) || {}).payload || {};
            var idx = (typeof p.index === "number") ? p.index : (s._queue.length - 1);
            if (idx >= 0 && idx < s._queue.length) {
                var item = s._queue[idx];
                // Refund full cost.
                var cost = item.kind === "unit" ? s._unitCosts[item.type] : s._buildingCosts[item.type];
                if (cost) {
                    s.scene.events.game.emit("resource_request", {
                        minerals: -(cost.minerals || 0),
                        gas: -(cost.gas || 0),
                        supply: item.kind === "unit" ? -(cost.supply || 0) : 0
                    });
                }
                s._queue.splice(idx, 1);
                s._publishHud();
            }
        });
    }

    _tryTrainUnit(type) {
        var c = this._unitCosts[type];
        if (!c) return;
        if (this._minerals < c.minerals || this._gas < c.gas) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_004.ogg", 0.3);
            return;
        }
        if (this._supply + (c.supply || 0) > this._supplyMax) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_004.ogg", 0.3);
            return;
        }
        // Reserve resources via a request event the resource_system honours.
        this.scene.events.game.emit("resource_request", {
            minerals: c.minerals,
            gas: c.gas,
            supply: c.supply || 0
        });
        this._queue.push({ kind: "unit", type: type, remaining: c.build, total: c.build });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.35);
        this._publishHud();
    }

    _tryBuildStructure(type) {
        var c = this._buildingCosts[type];
        if (!c) return;
        if (this._minerals < c.minerals || this._gas < c.gas) {
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_004.ogg", 0.3);
            return;
        }
        this.scene.events.game.emit("resource_request", {
            minerals: c.minerals,
            gas: c.gas,
            supply: 0
        });
        this._queue.push({ kind: "structure", type: type, remaining: c.build, total: c.build });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_002.ogg", 0.35);
        this._publishHud();
    }

    onUpdate(dt) {
        if (!this._gameActive) return;

        // Tick the head of the queue (one item at a time keeps it simple).
        if (this._queue.length > 0) {
            var head = this._queue[0];
            head.remaining -= dt;
            if (head.remaining <= 0) {
                this._completeBuild(head);
                this._queue.shift();
            }
        }

        this._publishHud();
    }

    _completeBuild(item) {
        // Spawn near a player command_center.
        var cc = this._findPlayerAnchor();
        var px = 0, pz = 0;
        if (cc) {
            var p = cc.transform.position;
            px = p.x;
            pz = p.z;
        }
        // Random offset in a ring around the anchor.
        var angle = Math.random() * Math.PI * 2;
        var radius = item.kind === "structure" ? 8 : 4;
        var ox = px + Math.cos(angle) * radius;
        var oz = pz + Math.sin(angle) * radius;

        var ent = this.scene.spawnEntity(item.type);
        if (ent) {
            this.scene.setPosition(ent.id, ox, 0, oz);
        }
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/confirmation_004.ogg", 0.35);
        this.scene.events.game.emit("unit_produced", { type: item.type, kind: item.kind });

        // Static spawn manifest so the validator sees every possible name.
        if (false) this._spawnManifest();
    }

    _spawnManifest() {
        // Never executed — exists so the assembler validator can see every
        // entity name we might pass to spawnEntity dynamically above.
        this.scene.spawnEntity("worker");
        this.scene.spawnEntity("marine");
        this.scene.spawnEntity("marine_female");
        this.scene.spawnEntity("medic");
        this.scene.spawnEntity("ghost");
        this.scene.spawnEntity("tank");
        this.scene.spawnEntity("siege_tank");
        this.scene.spawnEntity("mech_walker");
        this.scene.spawnEntity("battle_mech");
        this.scene.spawnEntity("scout_mech");
        this.scene.spawnEntity("barracks");
        this.scene.spawnEntity("factory");
        this.scene.spawnEntity("mech_bay");
        this.scene.spawnEntity("refinery");
        this.scene.spawnEntity("supply_depot");
        this.scene.spawnEntity("engineering_bay");
        this.scene.spawnEntity("turret_cannon");
        this.scene.spawnEntity("turret_laser");
    }

    _findPlayerAnchor() {
        var ccs = this.scene.findEntitiesByTag("command_center") || [];
        for (var i = 0; i < ccs.length; i++) {
            if (ccs[i].active) return ccs[i];
        }
        var bs = this.scene.findEntitiesByTag("player_building") || [];
        for (var j = 0; j < bs.length; j++) {
            if (bs[j].active) return bs[j];
        }
        return null;
    }

    _publishHud() {
        var queueView = [];
        for (var i = 0; i < this._queue.length; i++) {
            var q = this._queue[i];
            queueView.push({
                kind: q.kind,
                type: q.type,
                remaining: Math.max(0, q.remaining),
                total: q.total,
                progress: 1 - Math.max(0, q.remaining) / q.total
            });
        }

        var unitView = [];
        var unitOrder = ["worker", "marine", "marine_female", "medic", "ghost", "tank", "siege_tank", "mech_walker", "battle_mech", "scout_mech"];
        for (var u = 0; u < unitOrder.length; u++) {
            var key = unitOrder[u];
            var c = this._unitCosts[key];
            unitView.push({
                type: key,
                minerals: c.minerals,
                gas: c.gas,
                supply: c.supply,
                affordable: this._minerals >= c.minerals && this._gas >= c.gas && (this._supply + c.supply) <= this._supplyMax
            });
        }

        var bldView = [];
        var bldOrder = ["barracks", "factory", "mech_bay", "refinery", "supply_depot", "engineering_bay", "turret_cannon", "turret_laser"];
        for (var b = 0; b < bldOrder.length; b++) {
            var bkey = bldOrder[b];
            var bc = this._buildingCosts[bkey];
            bldView.push({
                type: bkey,
                minerals: bc.minerals,
                gas: bc.gas,
                affordable: this._minerals >= bc.minerals && this._gas >= bc.gas
            });
        }

        this.scene.events.ui.emit("hud_update", {
            buildQueue: queueView,
            buildableUnits: unitView,
            buildableStructures: bldView
        });
    }
}
