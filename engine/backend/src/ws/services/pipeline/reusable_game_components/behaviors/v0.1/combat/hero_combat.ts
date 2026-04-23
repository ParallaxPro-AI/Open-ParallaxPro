// also: RPG character, player progression, ability cooldown, character lifecycle
// Hero combat — health, mana, auto-attack, Q/E/Space abilities, death + respawn
class HeroCombatBehavior extends GameScript {
    _behaviorName = "hero_combat";
    _health = 500;
    _maxHealth = 500;
    _mana = 200;
    _maxMana = 200;
    _manaRegen = 5;
    _attackDamage = 30;
    _attackRange = 8;
    _attackRate = 1.0;
    _attackCooldown = 0;
    _attackSound = "/assets/kenney/audio/sci_fi_sounds/laserSmall_000.ogg";

    // Q — Arcane Burst (AoE damage)
    _qDamage = 80;
    _qRange = 6;
    _qCooldown = 0;
    _qMaxCooldown = 8;
    _qManaCost = 50;

    // E — Barrier (self heal)
    _eHeal = 100;
    _eCooldown = 0;
    _eMaxCooldown = 12;
    _eManaCost = 40;

    // Space — Dash
    _dashSpeed = 30;
    _dashDuration = 0.2;
    _spaceCooldown = 0;
    _spaceMaxCooldown = 6;
    _spaceManaCost = 30;
    _dashing = false;
    _dashTimer = 0;
    _dashVx = 0;
    _dashVz = 0;

    _dead = false;
    _respawnTime = 5;
    _startX = -45;
    _startZ = 0;

    onStart() {
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._startZ = pos.z;
        this._health = this._maxHealth;
        this._mana = this._maxMana;

        var self = this;

        this.scene.events.game.on("entity_damaged", function(data) {
            if (data.entityId !== self.entity.id || self._dead) return;
            self._health -= data.amount || 0;
            if (self._health <= 0) {
                self._health = 0;
                self._dead = true;
                self.scene._heroDead = true;
                self.scene.events.game.emit("champion_died", {});
                self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
                setTimeout(function() {
                    self._health = self._maxHealth;
                    self._mana = self._maxMana;
                    self._dead = false;
                    self.scene._heroDead = false;
                    self.scene.setPosition(self.entity.id, self._startX, 0, self._startZ);
                    self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
                    self.scene.events.game.emit("player_respawned", {});
                    self._sendHUD();
                }, self._respawnTime * 1000);
            }
            self._sendHUD();
        });

        this.scene.events.game.on("game_ready", function() {
            self._health = self._maxHealth;
            self._mana = self._maxMana;
            self._dead = false;
            self.scene._heroDead = false;
            self._qCooldown = 0;
            self._eCooldown = 0;
            self._spaceCooldown = 0;
            self._attackCooldown = 0;
            self._dashing = false;
            self.scene.setPosition(self.entity.id, self._startX, 0, self._startZ);
            self.scene.setVelocity(self.entity.id, { x: 0, y: 0, z: 0 });
            self._sendHUD();
        });
    }

    onUpdate(dt) {
        if (this._dead) {
            this._sendHUD();
            return;
        }

        // Mana regen
        this._mana = Math.min(this._maxMana, this._mana + this._manaRegen * dt);

        // Reduce cooldowns
        this._attackCooldown -= dt;
        this._qCooldown -= dt;
        this._eCooldown -= dt;
        this._spaceCooldown -= dt;

        // Active dash override
        if (this._dashing) {
            this._dashTimer -= dt;
            if (this._dashTimer <= 0) {
                this._dashing = false;
            } else {
                this.scene.setVelocity(this.entity.id, { x: this._dashVx, y: 0, z: this._dashVz });
                this._sendHUD();
                return;
            }
        }

        // Q — Arcane Burst (AoE)
        if (this.input.isKeyPressed("KeyQ") && this._qCooldown <= 0 && this._mana >= this._qManaCost) {
            this._mana -= this._qManaCost;
            this._qCooldown = this._qMaxCooldown;
            this.scene.events.game.emit("ability_used", {});
            var enemies = this._getEnemiesInRange(this._qRange);
            for (var i = 0; i < enemies.length; i++) {
                this.scene.events.game.emit("entity_damaged", { entityId: enemies[i].id, amount: this._qDamage, source: "hero_q" });
            }
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_002.ogg", 0.5);
        }

        // E — Barrier (Heal)
        if (this.input.isKeyPressed("KeyE") && this._eCooldown <= 0 && this._mana >= this._eManaCost) {
            this._mana -= this._eManaCost;
            this._eCooldown = this._eMaxCooldown;
            this._health = Math.min(this._maxHealth, this._health + this._eHeal);
            this.scene.events.game.emit("entity_healed", { entityId: this.entity.id, amount: this._eHeal });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/digital_audio/powerUp2.ogg", 0.5);
        }

        // Space — Dash
        if (this.input.isKeyPressed("Space") && this._spaceCooldown <= 0 && this._mana >= this._spaceManaCost) {
            this._mana -= this._spaceManaCost;
            this._spaceCooldown = this._spaceMaxCooldown;
            this._dashing = true;
            this._dashTimer = this._dashDuration;
            var yaw = (this.scene._heroYaw || 90) * Math.PI / 180;
            this._dashVx = Math.sin(yaw) * this._dashSpeed;
            this._dashVz = -Math.cos(yaw) * this._dashSpeed;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/thrusterFire_000.ogg", 0.3);
        }

        // Auto-attack nearest enemy in range
        if (this._attackCooldown <= 0) {
            var target = this._findNearestEnemy(this._attackRange);
            if (target) {
                this._attackCooldown = this._attackRate;
                this.scene.events.game.emit("entity_damaged", { entityId: target.id, amount: this._attackDamage, source: "hero_attack" });
                if (this.audio) this.audio.playSound(this._attackSound, 0.3);
            }
        }

        this._sendHUD();
    }

    _findNearestEnemy(range) {
        var pos = this.entity.transform.position;
        var enemies = this.scene.findEntitiesByTag("red_team");
        if (!enemies) return null;
        var nearest = null;
        var nearestDist = range;
        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            if (!e || !e.active) continue;
            var ep = e.transform.position;
            var dx = ep.x - pos.x, dz = ep.z - pos.z;
            var d = Math.sqrt(dx * dx + dz * dz);
            if (d < nearestDist) { nearestDist = d; nearest = e; }
        }
        return nearest;
    }

    _getEnemiesInRange(range) {
        var pos = this.entity.transform.position;
        var enemies = this.scene.findEntitiesByTag("red_team");
        if (!enemies) return [];
        var result = [];
        for (var i = 0; i < enemies.length; i++) {
            var e = enemies[i];
            if (!e || !e.active) continue;
            var ep = e.transform.position;
            var dx = ep.x - pos.x, dz = ep.z - pos.z;
            if (Math.sqrt(dx * dx + dz * dz) <= range) result.push(e);
        }
        return result;
    }

    _sendHUD() {
        this.scene.events.ui.emit("hud_update", {
            health: Math.round(this._health),
            maxHealth: this._maxHealth,
            mana: Math.round(this._mana),
            maxMana: this._maxMana,
            qCooldown: Math.max(0, Math.round(this._qCooldown * 10) / 10),
            qMaxCooldown: this._qMaxCooldown,
            eCooldown: Math.max(0, Math.round(this._eCooldown * 10) / 10),
            eMaxCooldown: this._eMaxCooldown,
            spaceCooldown: Math.max(0, Math.round(this._spaceCooldown * 10) / 10),
            spaceMaxCooldown: this._spaceMaxCooldown,
            heroDead: this._dead
        });
    }
}
