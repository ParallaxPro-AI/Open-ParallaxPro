// also: firearm, projectile, ammo management, reload mechanics, raycast hitDetection
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
            var dx, dy, dz;
            var gunX = pos.x, gunY = pos.y + 1.2, gunZ = pos.z;
            if (this.scene._aiming && this.scene._camPos && this.scene._camForward) {
                // Standard 3PS aim: raycast FROM the camera through the
                // crosshair to find the world aim point, then aim the
                // bullet from the gun TOWARD that point. The camera is
                // offset right+up+back from the player, so a parallel ray
                // from the gun would miss whatever the crosshair is on.
                var cp = this.scene._camPos;
                var cf = this.scene._camForward;
                var camHit = this.scene.raycast(cp.x, cp.y, cp.z, cf.x, cf.y, cf.z, this._range + 8, this.entity.id);
                var aimX, aimY, aimZ;
                var aimReach = camHit && camHit.distance ? camHit.distance : (this._range + 8);
                aimX = cp.x + cf.x * aimReach;
                aimY = cp.y + cf.y * aimReach;
                aimZ = cp.z + cf.z * aimReach;
                var rdx = aimX - gunX, rdy = aimY - gunY, rdz = aimZ - gunZ;
                var rlen = Math.sqrt(rdx * rdx + rdy * rdy + rdz * rdz) || 1;
                dx = rdx / rlen; dy = rdy / rlen; dz = rdz / rlen;
            } else {
                // Hip-fire: horizontal in the player's facing direction with
                // a slight downward bias so over-tall targets don't whiff.
                dx = Math.sin(yaw);
                dy = -0.05;
                dz = -Math.cos(yaw);
                var dirLen0 = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1;
                dx /= dirLen0; dy /= dirLen0; dz /= dirLen0;
            }
            var nx = dx, ny = dy, nz = dz;
            var ox = gunX + nx * 0.4;
            var oy = gunY;
            var oz = gunZ + nz * 0.4;
            var hit = this.scene.raycast(gunX, gunY, gunZ, dx, dy, dz, this._range, this.entity.id);
            var tracerLen = (hit && hit.distance) ? hit.distance : this._range;
            this._spawnTracer(ox, oy, oz, nx, ny, nz, tracerLen);
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

    _spawnTracer(ox, oy, oz, nx, ny, nz, len) {
        var scene = this.scene;
        if (!scene.createEntity || !scene.addComponent || len < 0.1) return;
        var midX = ox + nx * len * 0.5;
        var midY = oy + ny * len * 0.5;
        var midZ = oz + nz * len * 0.5;
        // Compute pitch + yaw to align the cube's long Z axis with the
        // ray direction. Same yaw convention as light_trail_emitter
        // (atan2(-x, -z)) so local -Z points along the ray; pitch lifts
        // the cube to follow vertical aim. Roll stays 0.
        var yawDeg = Math.atan2(-nx, -nz) * 180 / Math.PI;
        var pitchDeg = Math.asin(Math.max(-1, Math.min(1, ny))) * 180 / Math.PI;
        var name = "Tracer_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        var id = scene.createEntity(name);
        if (id == null) return;
        scene.setPosition(id, midX, midY, midZ);
        scene.setScale && scene.setScale(id, 0.04, 0.04, len);
        scene.addComponent(id, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: [1.0, 0.92, 0.45, 1.0],
            emissive: [0.9, 0.7, 0.2, 1.0],
        });
        var ent = scene.findEntityByName ? scene.findEntityByName(name) : null;
        if (ent && ent.transform && ent.transform.setRotationEuler) {
            ent.transform.setRotationEuler(pitchDeg, yawDeg, 0);
            ent.transform.markDirty && ent.transform.markDirty();
        }
        // Tracers are hit-flash-fast — short enough to feel like a real
        // muzzle streak, long enough that the eye registers the line.
        setTimeout(function() {
            if (scene.destroyEntity) scene.destroyEntity(id);
        }, 80);
    }
}
