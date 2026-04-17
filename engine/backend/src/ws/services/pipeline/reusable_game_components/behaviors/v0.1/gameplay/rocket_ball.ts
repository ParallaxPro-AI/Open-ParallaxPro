// Giant playable ball — the centerpiece of car-football games.
//
// The ball owns its own velocity (updated each frame) and responds to
// car overlaps with an impulse proportional to the car's forward
// velocity × an impact factor. We don't rely purely on the physics
// solver because capsule-vs-sphere penetration at high speed is noisy;
// manually nudging the velocity produces the arcade feel we want.
//
// Host-authoritative: the host ticks the ball, broadcasts its pose at
// a fixed cadence via net_rocket_ball_state, and all peers mirror the
// transform locally. Car collisions are resolved on the host too, so
// only one source of truth drives the ball.
//
// Reusable for any "giant ball" game (car soccer, cooperative puzzle
// pushing, etc.) — knobs for gravity, drag, bounce, impact factor, and
// arena bounds all live on the behavior params.
class RocketBallBehavior extends GameScript {
    _behaviorName = "rocket_ball";

    _gravity = -14;
    _drag = 0.3;
    _bounce = 0.78;
    _impactFactor = 1.15;
    _impactLift = 0.4;          // how much of the hit goes upward
    _arenaHalfX = 42;
    _arenaHalfZ = 28;
    _wallBounce = 0.82;
    _floorY = 1;
    _maxSpeed = 42;
    _syncInterval = 0.08;       // host broadcasts 12 Hz
    _hitRadius = 2.4;

    _vx = 0; _vy = 0; _vz = 0;
    _syncTimer = 0;
    _lastHitBy = "";
    _lastHitAt = 0;

    onStart() {
        var self = this;
        this.scene.events.game.on("net_rocket_ball_state", function(evt) {
            var d = (evt && evt.data) || {};
            self._applyRemoteBallState(d);
        });
        this.scene.events.game.on("net_rocket_ball_hit", function(evt) {
            var d = (evt && evt.data) || {};
            self._onRemoteHit(d);
        });
        this.scene.events.game.on("rocket_ball_reset", function(data) {
            self._reset(data || {});
        });
    }

    _reset(d) {
        var scene = this.scene;
        var nx = (d && typeof d.x === "number") ? d.x : 0;
        var ny = (d && typeof d.y === "number") ? d.y : 3;
        var nz = (d && typeof d.z === "number") ? d.z : 0;
        if (scene.setPosition) scene.setPosition(this.entity.id, nx, ny, nz);
        this._vx = 0; this._vy = 0; this._vz = 0;
    }

    onUpdate(dt) {
        var mp = this.scene._mp;
        var isHost = !mp || mp.isHost;

        var pos = this.entity.transform.position;

        if (!isHost) {
            // Non-host peers integrate locally between 12 Hz host
            // snapshots so the ball doesn't visibly teleport every
            // 80ms. _applyRemoteBallState seeds position + velocity;
            // here we just roll forward with the same gravity/drag
            // the host uses, so trajectories look continuous.
            this._vy += this._gravity * dt;
            var damp2 = Math.max(0, 1 - this._drag * dt);
            this._vx *= damp2;
            this._vz *= damp2;
            var nx2 = pos.x + this._vx * dt;
            var ny2 = pos.y + this._vy * dt;
            var nz2 = pos.z + this._vz * dt;
            if (ny2 < this._floorY) { ny2 = this._floorY; if (this._vy < 0) this._vy = 0; }
            if (this.scene.setPosition) this.scene.setPosition(this.entity.id, nx2, ny2, nz2);
            return;
        }

        // Gravity.
        this._vy += this._gravity * dt;

        // Drag (light — keeps the ball rolling for a while).
        var damp = Math.max(0, 1 - this._drag * dt);
        this._vx *= damp;
        this._vz *= damp;

        // Clamp speed.
        var spd = Math.sqrt(this._vx * this._vx + this._vy * this._vy + this._vz * this._vz);
        if (spd > this._maxSpeed) {
            var s = this._maxSpeed / spd;
            this._vx *= s; this._vy *= s; this._vz *= s;
        }

        var nx = pos.x + this._vx * dt;
        var ny = pos.y + this._vy * dt;
        var nz = pos.z + this._vz * dt;

        // Floor bounce — inelastic-ish.
        if (ny < this._floorY) {
            ny = this._floorY;
            if (this._vy < 0) {
                this._vy = -this._vy * this._bounce;
                if (Math.abs(this._vy) < 1.4) this._vy = 0;
                if (this.audio && Math.abs(spd) > 3) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_heavy_000.ogg", 0.25);
            }
        }
        // Arena walls.
        if (nx > this._arenaHalfX) { nx = this._arenaHalfX; this._vx = -Math.abs(this._vx) * this._wallBounce; }
        if (nx < -this._arenaHalfX) { nx = -this._arenaHalfX; this._vx = Math.abs(this._vx) * this._wallBounce; }
        if (nz > this._arenaHalfZ) { nz = this._arenaHalfZ; this._vz = -Math.abs(this._vz) * this._wallBounce; }
        if (nz < -this._arenaHalfZ) { nz = -this._arenaHalfZ; this._vz = Math.abs(this._vz) * this._wallBounce; }
        if (ny > 28) { ny = 28; this._vy = 0; }  // ceiling

        // scene.setPosition invalidates the world-matrix cache so the
        // renderer sees the new ball position. A bare pos.x += ... +
        // markDirty() leaves the cached matrix stale on physics-less
        // entities, and the ball looks frozen.
        if (this.scene.setPosition) this.scene.setPosition(this.entity.id, nx, ny, nz);

        // Car collisions — overlap-based so the whole stack is simple.
        var cars = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("car") : [];
        var now = Date.now();
        for (var i = 0; i < cars.length; i++) {
            var c = cars[i];
            if (!c || !c.transform) continue;
            var cp = c.transform.position;
            var dx = pos.x - cp.x, dy = pos.y - cp.y, dz = pos.z - cp.z;
            var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (d > this._hitRadius) continue;
            // Ignore a re-hit from the same car within 120ms so a single
            // touch doesn't double-stack impulses.
            var who = (c.getComponent ? (c.getComponent("NetworkIdentityComponent") || {}).ownerId : "") || c._rocketBotId || ("car_" + c.id);
            if (who === this._lastHitBy && now - this._lastHitAt < 120) continue;
            this._lastHitBy = who;
            this._lastHitAt = now;

            // Impulse: push the ball away from the car, with a share of
            // the car's current velocity added in so hits feel punchy.
            var rb = c.getComponent ? c.getComponent("RigidbodyComponent") : null;
            var cv = rb && rb.getLinearVelocity ? rb.getLinearVelocity() : { x: 0, y: 0, z: 0 };
            var nL = d > 0.0001 ? d : 0.0001;
            var nx = dx / nL, ny = dy / nL, nz = dz / nL;

            // "Heading speed" — velocity along the normal pointing away
            // from the car toward the ball (how hard we're ramming it).
            var heading = Math.max(0, cv.x * nx + cv.y * ny + cv.z * nz);
            var impulse = 6 + heading * this._impactFactor;
            this._vx = nx * impulse + cv.x * 0.3;
            this._vy = ny * impulse * 0.45 + impulse * this._impactLift + Math.max(0, cv.y * 0.4);
            this._vz = nz * impulse + cv.z * 0.3;

            // Broadcast the hit so the HUD + haptics peers can react.
            if (mp) {
                mp.sendNetworkedEvent("rocket_ball_hit", {
                    byPeerId: who,
                    x: pos.x, y: pos.y, z: pos.z,
                    impulse: impulse,
                });
            }
            this.scene.events.game.emit("rocket_ball_hit_local", {
                byPeerId: who,
                x: pos.x, y: pos.y, z: pos.z,
                impulse: impulse,
            });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPlate_heavy_002.ogg", 0.5);
            break;
        }

        // Broadcast pose (host → peers) at a throttled cadence.
        this._syncTimer += dt;
        if (this._syncTimer >= this._syncInterval && mp) {
            this._syncTimer = 0;
            mp.sendNetworkedEvent("rocket_ball_state", {
                x: pos.x, y: pos.y, z: pos.z,
                vx: this._vx, vy: this._vy, vz: this._vz,
            });
        }
    }

    _applyRemoteBallState(d) {
        var mp = this.scene._mp;
        if (!mp || mp.isHost) return;  // host owns the ball
        var pos = this.entity.transform.position;
        var nx = (typeof d.x === "number") ? d.x : pos.x;
        var ny = (typeof d.y === "number") ? d.y : pos.y;
        var nz = (typeof d.z === "number") ? d.z : pos.z;
        if (typeof d.vx === "number") this._vx = d.vx;
        if (typeof d.vy === "number") this._vy = d.vy;
        if (typeof d.vz === "number") this._vz = d.vz;
        if (this.scene.setPosition) this.scene.setPosition(this.entity.id, nx, ny, nz);
    }

    _onRemoteHit(d) {
        // Visual-only reaction on non-host peers. HUD + match system
        // already get the same payload via net_rocket_ball_hit; we play
        // a local thud here so the impact feels satisfying regardless
        // of who's host.
        if (!d) return;
        if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactPlate_heavy_003.ogg", 0.45);
    }
}
