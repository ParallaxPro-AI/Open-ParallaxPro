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
        // Multiplayer: remote player proxies share the behavior but must
        // not shoot — only the owning peer drives its own weapon.
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;

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
                var worldDist = (hit && hit.distance) ? hit.distance : 200;

                // Multiplayer: remote player proxies are spawned by the
                // network adapter without physics colliders, so the raycast
                // above never reports them. Do a manual capsule-vs-ray
                // intersection against every player entity and keep the
                // nearest one that's closer than the world hit.
                var mp = this.scene._mp;
                var playerHit = null;
                var playerDist = Infinity;
                if (mp && this.scene.findEntitiesByTag) {
                    var players = this.scene.findEntitiesByTag("player");
                    for (var pi = 0; pi < players.length; pi++) {
                        var pe = players[pi];
                        var peNi = pe.getComponent ? pe.getComponent("NetworkIdentityComponent") : null;
                        if (peNi && peNi.isLocalPlayer) continue;
                        if (!peNi || typeof peNi.ownerId !== "string" || !peNi.ownerId) continue;
                        var pp = pe.transform.position;
                        // Parameter t along the ray where the target projects.
                        var tox = pp.x - cp.x, toy = pp.y - cp.y, toz = pp.z - cp.z;
                        var t = tox * dx + toy * dy + toz * dz;
                        if (t < 0 || t > worldDist) continue;
                        // Perpendicular distance from the target's center to
                        // the ray line. 0.6 is a forgiving radius — player
                        // capsule is ~0.4 but the aim reticle is not infinitely
                        // precise, and this runs at 60Hz off user-driven
                        // clicks so it's fine to be generous.
                        var px = (cp.x + t * dx) - pp.x;
                        var py = (cp.y + t * dy) - (pp.y + 1.0); // aim at torso
                        var pz = (cp.z + t * dz) - pp.z;
                        var d2 = px * px + py * py + pz * pz;
                        if (d2 > 0.8 * 0.8) continue;
                        if (t < playerDist) { playerDist = t; playerHit = pe; }
                    }
                }

                if (playerHit) {
                    // Player hit beats wall hit — emit damage locally for
                    // feedback and broadcast so the victim's peer drops HP.
                    var targetNi = playerHit.getComponent("NetworkIdentityComponent");
                    this.scene.events.game.emit("entity_damaged", {
                        entityId: playerHit.id, amount: this._damage, source: "bullet"
                    });
                    if (mp && targetNi) {
                        mp.sendNetworkedEvent("player_shot", {
                            targetPeerId: targetNi.ownerId,
                            damage: this._damage,
                            shooterPeerId: mp.localPeerId,
                        });
                    }
                } else if (hit && hit.entityId) {
                    this.scene.events.game.emit("entity_damaged", {
                        entityId: hit.entityId, amount: this._damage, source: "bullet"
                    });
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
