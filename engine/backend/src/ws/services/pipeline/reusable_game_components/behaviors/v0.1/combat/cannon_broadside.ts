// also: naval-combat, dual-battery, ship-weapons, multiplayer
// Cannon broadsides — left click fires port (left) battery, right click
// fires starboard (right). Each side has independent ammo + reload so a
// captain can alternate sides for sustained fire. Cannons spawn a quick
// visual cannonball, do a short raycast hit check perpendicular to the
// ship's heading, and emit the standard entity_damaged + (in MP) a
// net_player_shot so the target peer applies the damage to its own hull.
//
// The behavior is owner-only — remote proxies don't fire — but every
// peer sees the muzzle flash and hears the boom because we publish a
// "weapon_fired" event the local side processes locally.
class CannonBroadsideBehavior extends GameScript {
    _behaviorName = "cannon_broadside";
    _damage = 30;
    _range = 32;
    _fireRate = 0.4;          // min seconds between shots from the same side
    _reloadTime = 3.5;        // full battery reload in seconds
    _maxAmmo = 4;             // shots per side before forced reload
    _muzzleHeight = 1.6;      // y-offset where the cannonball spawns
    _sideOffset = 1.6;        // x-offset from ship center for each side
    _spread = 0.18;           // randomized aim cone (radians)
    _balls = 3;               // cannonballs per broadside burst
    _burstDelay = 0.08;       // gap between balls in a burst
    _shotSound = "";
    _hitSound = "";
    _emptySound = "";

    _portAmmo = 4;
    _starAmmo = 4;
    _portReloading = false;
    _starReloading = false;
    _portReloadTimer = 0;
    _starReloadTimer = 0;
    _portCooldown = 0;
    _starCooldown = 0;
    _matchOver = false;
    _pendingBursts = [];

    onStart() {
        var self = this;
        this._portAmmo = this._maxAmmo;
        this._starAmmo = this._maxAmmo;
        this.scene.events.game.on("match_started", function() {
            self._matchOver = false;
            self._portAmmo = self._maxAmmo;
            self._starAmmo = self._maxAmmo;
            self._portReloading = false;
            self._starReloading = false;
            self._portCooldown = 0;
            self._starCooldown = 0;
            self._pendingBursts = [];
            self._sendHUD();
        });
        this.scene.events.game.on("match_ended", function() {
            self._matchOver = true;
        });
        // Remote peers spawn the same visual cannonball when someone else
        // fires. The shooter spawns locally in _fireOneBall AND broadcasts;
        // we ignore the rebroadcast on the sender to avoid double-rendering.
        this.scene.events.game.on("net_cannonball_fired", function(evt) {
            var d = (evt && evt.data) || {};
            var mp = self.scene._mp;
            if (mp && d.shooterPeerId && d.shooterPeerId === mp.localPeerId) return;
            self._spawnVisualBall(d.ox, d.oy, d.oz, d.dirX || 0, d.dirZ || 0);
        });
        this._sendHUD();
    }

    onUpdate(dt) {
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        if (ni && !ni.isLocalPlayer) return;
        if (this._matchOver) return;

        // Don't fire from a sunk ship.
        var hull = this.entity.getScript ? this.entity.getScript("ShipHealthBehavior") : null;
        if (hull && hull._sunk) return;

        this._portCooldown -= dt;
        this._starCooldown -= dt;

        // Reload progression
        if (this._portReloading) {
            this._portReloadTimer -= dt;
            if (this._portReloadTimer <= 0) {
                this._portAmmo = this._maxAmmo;
                this._portReloading = false;
                this._sendHUD();
            }
        }
        if (this._starReloading) {
            this._starReloadTimer -= dt;
            if (this._starReloadTimer <= 0) {
                this._starAmmo = this._maxAmmo;
                this._starReloading = false;
                this._sendHUD();
            }
        }

        // Process pending burst balls (small staggered fire)
        if (this._pendingBursts.length > 0) {
            var nextKept = [];
            for (var i = 0; i < this._pendingBursts.length; i++) {
                var b = this._pendingBursts[i];
                b.delay -= dt;
                if (b.delay <= 0) this._fireOneBall(b.side);
                else nextKept.push(b);
            }
            this._pendingBursts = nextKept;
        }

        // Manual reload — R reloads BOTH sides at once (quality of life).
        if (this.input.isKeyPressed && this.input.isKeyPressed("KeyR")) {
            if (!this._portReloading && this._portAmmo < this._maxAmmo) {
                this._portReloading = true;
                this._portReloadTimer = this._reloadTime;
            }
            if (!this._starReloading && this._starAmmo < this._maxAmmo) {
                this._starReloading = true;
                this._starReloadTimer = this._reloadTime;
            }
            this._sendHUD();
        }

        // Port broadside (left click)
        if (this.input.isKeyPressed && this.input.isKeyPressed("MouseLeft")) {
            this._tryBroadside("port");
        }
        // Starboard broadside (right click)
        if (this.input.isKeyPressed && this.input.isKeyPressed("MouseRight")) {
            this._tryBroadside("starboard");
        }
    }

    _tryBroadside(side) {
        var ammoOk = (side === "port" ? this._portAmmo : this._starAmmo) > 0;
        var coolOk = (side === "port" ? this._portCooldown : this._starCooldown) <= 0;
        var reloading = (side === "port" ? this._portReloading : this._starReloading);
        if (!coolOk) return;
        if (reloading || !ammoOk) {
            // Empty click — soft thunk so the player knows they're dry.
            if (this._emptySound && this.audio) this.audio.playSound(this._emptySound, 0.25);
            // Auto-trigger reload if we're empty and not already reloading.
            if (side === "port" && !this._portReloading && this._portAmmo < this._maxAmmo) {
                this._portReloading = true;
                this._portReloadTimer = this._reloadTime;
                this._sendHUD();
            }
            if (side === "starboard" && !this._starReloading && this._starAmmo < this._maxAmmo) {
                this._starReloading = true;
                this._starReloadTimer = this._reloadTime;
                this._sendHUD();
            }
            return;
        }
        if (side === "port") {
            this._portAmmo--;
            this._portCooldown = this._fireRate;
        } else {
            this._starAmmo--;
            this._starCooldown = this._fireRate;
        }
        // Queue burst — first ball fires immediately, rest are delayed.
        for (var b = 0; b < this._balls; b++) {
            if (b === 0) this._fireOneBall(side);
            else this._pendingBursts.push({ side: side, delay: this._burstDelay * b });
        }
        this.scene.events.game.emit("weapon_fired", {
            ammo: side === "port" ? this._portAmmo : this._starAmmo,
            reserve: this._maxAmmo,
            weapon: side === "port" ? "Port Cannons" : "Starboard Cannons",
        });
        if (this._shotSound && this.audio) this.audio.playSound(this._shotSound, 0.55);
        // Auto-reload when emptied.
        if (side === "port" && this._portAmmo <= 0) {
            this._portReloading = true;
            this._portReloadTimer = this._reloadTime;
        }
        if (side === "starboard" && this._starAmmo <= 0) {
            this._starReloading = true;
            this._starReloadTimer = this._reloadTime;
        }
        this._sendHUD();
    }

    _fireOneBall(side) {
        // Compute world-space direction perpendicular to ship heading.
        var yaw = (this.scene._shipYaw || 0) * Math.PI / 180;
        // Ship faces -Z when yaw=0; right-hand perpendicular is +X. Port
        // is left of facing, starboard is right.
        var sign = side === "starboard" ? 1 : -1;
        // Apply small spread per ball so the volley scatters.
        var spread = (Math.random() - 0.5) * 2 * this._spread;
        var dirX = Math.cos(yaw) * sign + Math.sin(yaw + Math.PI / 2) * spread * 0.3;
        var dirZ = Math.sin(yaw) * sign + (-Math.cos(yaw + Math.PI / 2)) * spread * 0.3;
        var len = Math.sqrt(dirX * dirX + dirZ * dirZ) || 1;
        dirX /= len; dirZ /= len;

        var pos = this.entity.transform.position;
        var ox = pos.x + dirX * this._sideOffset;
        var oz = pos.z + dirZ * this._sideOffset;
        var oy = (pos.y || 0) + this._muzzleHeight;

        // Local visual + broadcast so every peer sees it.
        this._spawnVisualBall(ox, oy, oz, dirX, dirZ);
        var mpForVisual = this.scene._mp;
        if (mpForVisual) {
            mpForVisual.sendNetworkedEvent("cannonball_fired", {
                ox: ox, oy: oy, oz: oz, dirX: dirX, dirZ: dirZ,
                shooterPeerId: mpForVisual.localPeerId,
            });
        }

        // Hit detection: short raycast from muzzle along ball direction.
        // Skip our own ship via the 4th raycast arg (excludeId).
        var ownId = this.entity.id;
        if (this.scene.raycast) {
            var hit = this.scene.raycast(ox, oy, oz, dirX, 0, dirZ, this._range, ownId);
            if (hit && hit.entityId) {
                this.scene.events.game.emit("entity_damaged", {
                    entityId: hit.entityId, amount: this._damage, source: "cannon",
                });
                if (this._hitSound && this.audio) this.audio.playSound(this._hitSound, 0.5);
                // Multiplayer: forward hit to target peer if it's another captain.
                var mp = this.scene._mp;
                if (mp) {
                    var hitEntity = this.scene.getEntity ? this.scene.getEntity(hit.entityId) : null;
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
    }

    _spawnVisualBall(ox, oy, oz, dirX, dirZ) {
        if (!this.scene.createEntity || !this.scene.addComponent) return;
        var ballId = this.scene.createEntity("Cannonball");
        if (ballId == null) return;
        this.scene.setPosition(ballId, ox, oy, oz);
        this.scene.setScale && this.scene.setScale(ballId, 0.4, 0.4, 0.4);
        this.scene.addComponent(ballId, "MeshRendererComponent", {
            meshType: "sphere",
            baseColor: [0.06, 0.06, 0.06, 1],
        });
        // Schedule despawn after ~0.6s — matches the visible flight
        // distance and keeps the scene from accumulating balls.
        var sceneRef = this.scene;
        var startMs = Date.now();
        var bx = ox, bz = oz, by = oy;
        var endX = ox + dirX * this._range;
        var endZ = oz + dirZ * this._range;
        var endY = oy - 1.5;        // gentle arc droop
        var anim = function() {
            var t = Math.min(1, (Date.now() - startMs) / 600);
            var nx = bx + (endX - bx) * t;
            var nz = bz + (endZ - bz) * t;
            var arc = -Math.sin(t * Math.PI) * 0.6;
            var ny = by + (endY - by) * t + arc;
            if (sceneRef.setPosition) sceneRef.setPosition(ballId, nx, ny, nz);
            if (t < 1) {
                if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(anim);
            } else {
                if (sceneRef.destroyEntity) sceneRef.destroyEntity(ballId);
            }
        };
        if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(anim);
        else if (sceneRef.destroyEntity) setTimeout(function() { sceneRef.destroyEntity(ballId); }, 600);
    }

    _sendHUD() {
        this.scene.events.ui.emit("hud_update", {
            shipStatus: {
                portAmmo: this._portAmmo,
                starAmmo: this._starAmmo,
                portMax: this._maxAmmo,
                starMax: this._maxAmmo,
                portReloading: this._portReloading,
                starReloading: this._starReloading,
                portReloadPct: this._portReloading ? Math.floor((1 - this._portReloadTimer / this._reloadTime) * 100) : 100,
                starReloadPct: this._starReloading ? Math.floor((1 - this._starReloadTimer / this._reloadTime) * 100) : 100,
            },
        });
    }
}
