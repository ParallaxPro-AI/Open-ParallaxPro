// also: shooting, raycast-hit, ammo-system, multiplayer-weapons
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
    _matchOver = false;
    // Visible tracers — short-lived spheres lerping from gun → hit point
    // so the player can see each shot. Damage is still applied at fire-
    // time via the raycast above; the tracer is purely cosmetic.
    _tracers = [];

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended", function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
        // Render tracers fired by remote peers. Every fps_combat instance
        // (the local player AND every remote-player proxy) subscribes to
        // the same scene-wide event, so we filter to the local-player
        // instance and skip our own broadcasts. Without this gate one
        // remote shot would spawn N tracers (one per peer-proxy entity).
        this.scene.events.game.on("net_fps_shot", function(evt) {
            var ni = self.entity.getComponent ? self.entity.getComponent("NetworkIdentityComponent") : null;
            if (ni && !ni.isLocalPlayer) return;
            var d = (evt && evt.data) || {};
            if (!d.from || !d.to) return;
            var mp = self.scene._mp;
            if (mp && d.shooterPeerId === mp.localPeerId) return;
            self._spawnTracer(d.from.x, d.from.y, d.from.z, d.to.x, d.to.y, d.to.z);
        });
    }

    onUpdate(dt) {
        // Tracers fly regardless of match-state / local-player gating —
        // they're spawned by THIS peer's fire path so they only need
        // to advance whenever the script ticks.
        this._updateTracers(dt);
        // No firing / reloading between matches — mouse clicks on the
        // game-over screen are for UI, not bullets.
        if (this._matchOver) return;
        // Multiplayer: remote player proxies share the behavior but must
        // not shoot — only the owning peer drives its own weapon.
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

        // No shooting while dead (also no reload progression — timer
        // freezes rather than snapping to ready on respawn).
        var health = this.entity.getScript ? this.entity.getScript("PlayerHealthBehavior") : null;
        if (health && health._dead) return;

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

            // Raycast from camera center along the look direction. Yaw
            // and pitch both come from camera_fps via scene globals
            // (_fpsYaw / _fpsPitch); reading them through getScript is
            // unreliable here because the camera entity isn't always
            // resolvable by name across templates.
            var cam = this.scene.findEntityByName("Camera");
            if (cam) {
                var cp = cam.transform.position;
                var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
                var pitch = (this.scene._fpsPitch || 0) * Math.PI / 180;
                var dx = Math.sin(yaw) * Math.cos(pitch);
                var dy = Math.sin(pitch);
                var dz = -Math.cos(yaw) * Math.cos(pitch);
                var hit = this.scene.raycast(cp.x, cp.y, cp.z, dx, dy, dz, 200, this.entity.id);
                // Tracer endpoint — hit point if anything was hit, else
                // the max-range point along the fire ray. Spawn slightly
                // forward of the camera so the bullet doesn't appear
                // INSIDE the player's view.
                var endX, endY, endZ;
                if (hit && hit.point) {
                    endX = hit.point.x; endY = hit.point.y; endZ = hit.point.z;
                } else {
                    endX = cp.x + dx * 200;
                    endY = cp.y + dy * 200;
                    endZ = cp.z + dz * 200;
                }
                var trFromX = cp.x + dx * 1.0;
                var trFromY = cp.y + dy * 1.0 - 0.15;
                var trFromZ = cp.z + dz * 1.0;
                this._spawnTracer(trFromX, trFromY, trFromZ, endX, endY, endZ);
                // Broadcast the shot so remote peers also render a tracer
                // — without this, only the shooter sees their bullet.
                var mpBroadcast = this.scene._mp;
                if (mpBroadcast) {
                    mpBroadcast.sendNetworkedEvent("fps_shot", {
                        from: { x: trFromX, y: trFromY, z: trFromZ },
                        to: { x: endX, y: endY, z: endZ },
                        shooterPeerId: mpBroadcast.localPeerId
                    });
                }
                if (hit && hit.entityId) {
                    // Always fire the local damage event so single-player
                    // enemies, crates, barrels, etc. react immediately.
                    this.scene.events.game.emit("entity_damaged", {
                        entityId: hit.entityId, amount: this._damage, source: "bullet"
                    });

                    // Multiplayer: if the hit target carries a
                    // NetworkIdentity with an ownerId, it's a remote
                    // player proxy. Broadcast so the target's peer
                    // applies the damage on their own authoritative
                    // health. We look the entity up on the scene because
                    // raycast only returns entityId, not the Entity
                    // object.
                    var mp = this.scene._mp;
                    if (mp) {
                        var hitEntity = this.scene.getEntity
                            ? this.scene.getEntity(hit.entityId)
                            : null;
                        var targetNi = hitEntity && hitEntity.getComponent
                            ? hitEntity.getComponent("NetworkIdentityComponent")
                            : null;
                        if (targetNi && typeof targetNi.ownerId === "string" && targetNi.ownerId) {
                            mp.sendNetworkedEvent("player_shot", {
                                targetPeerId: targetNi.ownerId,
                                damage: this._damage,
                                shooterPeerId: mp.localPeerId,
                            });
                        }
                    }
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

    _spawnTracer(fromX, fromY, fromZ, toX, toY, toZ) {
        if (!this.scene.createEntity) return;
        var name = "tr_" + Date.now() + "_" + Math.floor(Math.random() * 100000);
        var id = this.scene.createEntity(name);
        if (id == null || id === -1) return;
        this.scene.setScale && this.scene.setScale(id, 0.12, 0.12, 0.12);
        this.scene.addComponent(id, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [1.0, 0.95, 0.40, 1]
        });
        this.scene.setPosition(id, fromX, fromY, fromZ);
        if (this.scene.addTag) this.scene.addTag(id, "tracer");
        var dx = toX - fromX, dy = toY - fromY, dz = toZ - fromZ;
        var dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        // 80 u/s — fast enough that a 50m shot takes ~0.6s, slow enough
        // to be visible. Floor at 0.05s for very-close hits so the
        // tracer doesn't blink.
        var duration = Math.max(0.05, dist / 80);
        this._tracers.push({
            id: id, t: 0, duration: duration,
            fromX: fromX, fromY: fromY, fromZ: fromZ,
            toX: toX, toY: toY, toZ: toZ
        });
    }

    _updateTracers(dt) {
        for (var i = this._tracers.length - 1; i >= 0; i--) {
            var p = this._tracers[i];
            p.t += dt;
            var alpha = p.t / p.duration;
            if (alpha >= 1) {
                try { this.scene.destroyEntity && this.scene.destroyEntity(p.id); } catch (e) {}
                this._tracers.splice(i, 1);
                continue;
            }
            this.scene.setPosition(p.id,
                p.fromX + (p.toX - p.fromX) * alpha,
                p.fromY + (p.toY - p.fromY) * alpha,
                p.fromZ + (p.toZ - p.fromZ) * alpha);
        }
    }
}
