// FPS combat — shoot with left click, raycast to detect hits
class FPSCombatBehavior extends GameScript {
    _behaviorName = "fps_combat";
    _ammo = 30;
    _maxAmmo = 30;
    _reserve = 90;
    _damage = 25;
    _fireRate = 0.1;
    _reloadTime = 2.0;
    _fireCooldown = 0;
    _reloading = false;
    _reloadTimer = 0;
    _weaponName = "Rifle";
    _shootSound = "";

    onUpdate(dt) {
        this._fireCooldown -= dt;

        // Reload
        if (this._reloading) {
            this._reloadTimer -= dt;
            if (this._reloadTimer <= 0) {
                var reload = Math.min(this._maxAmmo - this._ammo, this._reserve);
                this._ammo += reload;
                this._reserve -= reload;
                this._reloading = false;
                this.scene.events.game.emit("reload_complete", { ammo: this._ammo });
                this._sendHUD();
            }
            return;
        }

        // Manual reload
        if (this.input.isKeyPressed("KeyR") && this._ammo < this._maxAmmo && this._reserve > 0) {
            this._reloading = true;
            this._reloadTimer = this._reloadTime;
            return;
        }

        // Fire
        if (this.input.isKeyDown("MouseLeft") && this._fireCooldown <= 0 && this._ammo > 0) {
            this._ammo--;
            this._fireCooldown = this._fireRate;
            this.scene.events.game.emit("weapon_fired", { ammo: this._ammo, reserve: this._reserve, weapon: this._weaponName });
            if (this._shootSound && this.audio) this.audio.playSound(this._shootSound, 0.5);

            // Raycast from camera center
            var cam = this.scene.findEntityByName("Camera");
            if (cam) {
                var cp = cam.transform.position;
                var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
                var pitch = 0;
                // Get pitch from camera direction
                var camEntity = this.scene.findEntityByName("Camera");
                if (camEntity) {
                    var scripts = camEntity.getScript ? camEntity.getScript("CameraFPSBehavior") : null;
                    if (scripts && scripts._pitchDeg !== undefined) pitch = scripts._pitchDeg * Math.PI / 180;
                }
                var dx = Math.sin(yaw) * Math.cos(pitch);
                var dy = Math.sin(pitch);
                var dz = -Math.cos(yaw) * Math.cos(pitch);
                var hit = this.scene.raycast(cp.x, cp.y, cp.z, dx, dy, dz, 200, this.entity.id);
                if (hit && hit.entityId) {
                    this.scene.events.game.emit("entity_damaged", { entityId: hit.entityId, amount: this._damage, source: "bullet" });
                }
            }

            // Auto-reload when empty
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
            weaponName: this._weaponName
        });
    }
}
