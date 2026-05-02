// also: MMO interaction, click-to-target, NPC dialog, loot pickup, quest accept
// MMORPG interaction — virtual cursor + click handling for the player.
//
// Left-click on:
//   - an enemy/hostile mob → set as the player's combat target (emit
//     `target_set`) and immediately apply a small click-attack damage so
//     the click feels responsive. Autonomous combat behaviors continue
//     to land the heavy hits.
//   - an NPC (quest_giver / merchant / healer / innkeeper) → emit
//     `npc_clicked` with the npc tag so a dialog HUD or quest_system can
//     react. Also publishes the latest dialog text to the HUD via
//     hud_update.npcDialog.
//   - a loot entity (chest / potion / collectible) → pick it up: deactivate
//     the entity, emit `loot_picked_up` with a small reward, and play a
//     pickup sound.
class MMORPGInteractSystem extends GameScript {
    _gameActive = false;
    _pickRadius = 2.2;
    _clickDamage = 5;
    _interactRange = 8; // world-units; click-to-loot/talk requires the
                        // player to be reasonably close.
    _targetId = "";
    _npcDialog = "";

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._gameActive = true;
            self._targetId = "";
            self._npcDialog = "";
        });
        // Click handling is event-driven so the click coords match what
        // the user actually touched. ui_bridge emits cursor_click with
        // the freshest canvas-relative pointer position; polling MouseLeft
        // against a cached _cursorX/Y from cursor_move loses the tap-frame
        // coords on touch devices, where a tap is the only event that
        // moves the cursor.
        this.scene.events.ui.on("cursor_click", function(d) {
            if (!d) return;
            self._handleClick(d.x, d.y);
        });
        this.scene.events.game.on("entity_killed", function(d) {
            if (d && d.entityId === self._targetId) self._targetId = "";
        });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;
        this._publishHud();
    }

    _handleClick(sx, sy) {
        if (!this._gameActive) return;
        if (!this.scene.screenPointToGround) return;

        var ground = this.scene.screenPointToGround(sx, sy, 0);
        if (!ground) return;

        // Player position used for proximity gates (talk / loot only land
        // when the player is close enough to the click point).
        var hero = this._findHero();
        var heroPos = hero ? hero.transform.position : { x: ground.x, z: ground.z };
        var heroDist = function(ep) {
            var dx = ep.x - heroPos.x, dz = ep.z - heroPos.z;
            return Math.sqrt(dx * dx + dz * dz);
        };

        // 1) Loot first — small radius, easiest to mis-click otherwise.
        var loot = this._nearestActive(this.scene.findEntitiesByTag("loot") || [], ground.x, ground.z, this._pickRadius);
        if (!loot) loot = this._nearestActive(this.scene.findEntitiesByTag("collectible") || [], ground.x, ground.z, this._pickRadius);
        if (loot) {
            if (heroDist(loot.transform.position) > this._interactRange) {
                this._npcDialog = "Too far away to pick up.";
            } else {
                loot.active = false;
                this.scene.events.game.emit("loot_picked_up", { entityId: loot.id });
                this.scene.events.game.emit("xp_gained", { amount: 10 });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/handleCoins.ogg", 0.45);
                this._npcDialog = "Picked up loot. +10 XP";
            }
            this._publishHud();
            return;
        }

        // 2) Enemy → target + click-attack.
        var enemy = this._nearestActive(this.scene.findEntitiesByTag("enemy") || [], ground.x, ground.z, this._pickRadius);
        if (!enemy) enemy = this._nearestActive(this.scene.findEntitiesByTag("hostile") || [], ground.x, ground.z, this._pickRadius);
        if (enemy) {
            this._targetId = enemy.id;
            this.scene.events.game.emit("target_set", { entityId: enemy.id });
            this.scene.events.game.emit("entity_damaged", {
                targetId: enemy.id,
                damage: this._clickDamage,
                source: "player"
            });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.3);
            this._npcDialog = "";
            this._publishHud();
            return;
        }

        // 3) NPC → talk / quest dialog.
        var npc = this._nearestActive(this.scene.findEntitiesByTag("npc") || [], ground.x, ground.z, this._pickRadius);
        if (npc) {
            if (heroDist(npc.transform.position) > this._interactRange) {
                this._npcDialog = "Walk closer to talk.";
            } else {
                var role = this._npcRole(npc);
                this.scene.events.game.emit("npc_clicked", { entityId: npc.id, role: role });
                if (role === "quest_giver") this._npcDialog = "Quest giver: 'I have work for you, hero.'";
                else if (role === "merchant") this._npcDialog = "Merchant: 'Care to browse my wares?'";
                else if (role === "healer") this._npcDialog = "Healer: 'Rest a moment, friend.'";
                else if (role === "innkeeper") this._npcDialog = "Innkeeper: 'Welcome to the inn.'";
                else if (role === "guard") this._npcDialog = "Guard: 'Stay safe out there.'";
                else this._npcDialog = "NPC: '...'";
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/cloth1.ogg", 0.3);
            }
            this._publishHud();
            return;
        }

        // 4) Empty ground click — clear current target.
        this._targetId = "";
        this._npcDialog = "";
        this._publishHud();
    }

    _findHero() {
        var heroes = this.scene.findEntitiesByTag("player") || [];
        for (var i = 0; i < heroes.length; i++) {
            if (heroes[i] && heroes[i].active) return heroes[i];
        }
        return null;
    }

    _npcRole(e) {
        var tags = e.tags || [];
        var roles = ["quest_giver", "merchant", "healer", "innkeeper", "guard"];
        for (var i = 0; i < tags.length; i++) {
            for (var r = 0; r < roles.length; r++) {
                if (tags[i] === roles[r]) return roles[r];
            }
        }
        return "npc";
    }

    _nearestActive(arr, x, z, radius) {
        var best = null;
        var bestD = radius * radius;
        for (var i = 0; i < arr.length; i++) {
            var e = arr[i];
            if (!e || !e.active) continue;
            var ep = e.transform.position;
            var dx = ep.x - x;
            var dz = ep.z - z;
            var d = dx * dx + dz * dz;
            if (d < bestD) {
                bestD = d;
                best = e;
            }
        }
        return best;
    }

    _publishHud() {
        this.scene.events.ui.emit("hud_update", {
            playerTargetId: this._targetId,
            npcDialog: this._npcDialog
        });
    }
}
