// Pistol combat — left click to shoot, R to reload, raycast from player facing direction
class PistolCombatBehavior extends GameScript {
    _behaviorName = "pistol_combat";
    _ammo = 12;
    _maxAmmo = 12;
    _reserve = 48;
    _damage = 35;
    _fireRate = 0.35;
    _reloadTime = 1.5;
    _range = 50;
    _fireCooldown = 0;
    _reloading = false;
    _reloadTimer = 0;
    _shootSound = "/assets/kenney/audio/sci_fi_sounds/laserSmall_002.ogg";
    _currentAnim = "";

    onStart() {
        this._sendHUD();
    }

    onUpdate(dt) {
        if (this.scene._inVehicle) return;
        this._fireCooldown -= dt;

        if (this._reloading) {
            this._reloadTimer -= dt;
            if (this._reloadTimer <= 0) {
                var reload = Math.min(this._maxAmmo - this._ammo, this._reserve);
                this._ammo += reload;
                this._reserve -= reload;
                this._reloading = false;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/click_004.ogg", 0.4);
                this._sendHUD();
            }
            return;
        }

        if (this.input.isKeyPressed("KeyR") && this._ammo < this._maxAmmo && this._reserve > 0) {
            this._reloading = true;
            this._reloadTimer = this._reloadTime;
            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/drawKnife1.ogg", 0.3);
            return;
        }

        if (this.input.isKeyDown("MouseLeft") && this._fireCooldown <= 0 && this._ammo > 0) {
            this._ammo--;
            this._fireCooldown = this._fireRate;

            if (this._shootSound && this.audio) this.audio.playSound(this._shootSound, 0.5);

            if (this.entity.playAnimation) {
                this.entity.playAnimation("Shoot_OneHanded", { loop: false });
                var self = this;
                setTimeout(function() {
                    if (self.entity.playAnimation && !self.scene._inVehicle) {
                        self.entity.playAnimation("Idle", { loop: true });
                    }
                }, 400);
            }

            this.scene.events.game.emit("weapon_fired", {
                ammo: this._ammo,
                reserve: this._reserve,
                weapon: "Pistol"
            });

            var pos = this.entity.transform.position;
            var yaw = (this.scene._tpYaw || 0) * Math.PI / 180;
            var dx = Math.sin(yaw);
            var dz = -Math.cos(yaw);
            var hit = this.scene.raycast(pos.x, pos.y + 1.2, pos.z, dx, -0.05, dz, this._range, this.entity.id);
            if (hit && hit.entityId) {
                this.scene.events.game.emit("entity_damaged", {
                    entityId: hit.entityId,
                    amount: this._damage,
                    source: "pistol"
                });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPunch_medium_000.ogg", 0.4);
            }

            if (this._ammo <= 0 && this._reserve > 0) {
                this._reloading = true;
                this._reloadTimer = this._reloadTime;
            }

            this._sendHUD();
        }
    }

    _sendHUD() {
        this.scene.events.ui.emit("hud_update", {
            ammo: this._ammo,
            ammoReserve: this._reserve,
            weaponName: "Pistol"
        });
    }
}
