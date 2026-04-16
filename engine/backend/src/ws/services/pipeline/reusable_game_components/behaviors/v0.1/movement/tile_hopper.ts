// Tile Hopper — grid-based hop movement.
//
// The player occupies one tile at a time and hops to an adjacent tile
// when an arrow/WASD key is tapped. A short parabolic arc animates the
// transition (0.15s by default) so consecutive taps queue cleanly.
//
// Exposes `scene._tileHopperState` each tick with the player's current
// tile coords, world position, animation phase, and whether a platform
// (log, etc.) is riding under the chicken — the match system uses that
// to decide whether a river tile is lethal.
//
// Reusable for any grid-hop game — tweak _tileSize / _hopSeconds / axis
// conventions via params. The match system owns actual collision and
// death; this behavior only drives animation + input queue.
class TileHopperBehavior extends GameScript {
    _behaviorName = "tile_hopper";

    _tileSize = 2;               // world units per tile (x + z)
    _hopSeconds = 0.16;
    _hopArcHeight = 0.7;
    _restHeight = 0.6;           // y of the player model when standing
    _turnSpeed = 24;
    _queueWindow = 0.14;         // time before landing during which input queues

    _tileX = 0;                  // integer tile coords
    _tileZ = 0;
    _hopping = false;
    _hopT = 0;
    _hopFrom = { x: 0, y: 0, z: 0 };
    _hopTo = { x: 0, y: 0, z: 0 };
    _queued = null;              // { dx, dz } pending input
    _prev = { up: false, down: false, left: false, right: false };
    _facingYaw = 0;
    _platformOffsetX = 0;        // river-log drift offset carried over (in m)
    _platformOffsetZ = 0;

    onStart() {
        var self = this;
        this.scene.events.game.on("hop_reset", function(data) {
            var d = data || {};
            self._tileX = (typeof d.tx === "number") ? d.tx : 0;
            self._tileZ = (typeof d.tz === "number") ? d.tz : 0;
            self._hopping = false;
            self._hopT = 0;
            self._queued = null;
            self._platformOffsetX = 0;
            self._platformOffsetZ = 0;
            var pos = self.entity.transform.position;
            pos.x = self._tileX * self._tileSize;
            pos.y = self._restHeight;
            pos.z = self._tileZ * self._tileSize;
            self._facingYaw = 0;
            self.entity.transform.setRotationEuler && self.entity.transform.setRotationEuler(0, 0, 0);
            self.entity.transform.markDirty && self.entity.transform.markDirty();
        });
    }

    onUpdate(dt) {
        if (this.scene._hopFrozen) {
            this.scene._tileHopperState = this._buildState(false);
            return;
        }

        // Read taps with edge detection.
        var up    = this._edge(this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp"),    "up");
        var down  = this._edge(this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown"),  "down");
        var left  = this._edge(this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft"),  "left");
        var right = this._edge(this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight"), "right");

        var intent = null;
        if (up)    intent = { dx: 0,  dz: -1, yaw: 0 };
        else if (down)  intent = { dx: 0,  dz:  1, yaw: Math.PI };
        else if (left)  intent = { dx: -1, dz:  0, yaw: -Math.PI / 2 };
        else if (right) intent = { dx:  1, dz:  0, yaw:  Math.PI / 2 };

        if (intent) {
            if (!this._hopping) this._beginHop(intent);
            else if (this._hopT >= (this._hopSeconds - this._queueWindow)) this._queued = intent;
            else this._queued = intent;  // always queue most recent tap
        }

        if (this._hopping) {
            this._hopT += dt;
            var a = Math.min(1, this._hopT / this._hopSeconds);
            var fromX = this._hopFrom.x + this._platformOffsetX;
            var fromZ = this._hopFrom.z + this._platformOffsetZ;
            var x = fromX + (this._hopTo.x - fromX) * a;
            var z = fromZ + (this._hopTo.z - fromZ) * a;
            var arc = Math.sin(Math.PI * a) * this._hopArcHeight;
            var y = this._restHeight + arc;
            var pos = this.entity.transform.position;
            pos.x = x; pos.y = y; pos.z = z;
            this.entity.transform.markDirty && this.entity.transform.markDirty();

            if (a >= 1) {
                this._hopping = false;
                this._hopT = 0;
                this._platformOffsetX = 0;
                this._platformOffsetZ = 0;
                pos.x = this._hopTo.x;
                pos.y = this._restHeight;
                pos.z = this._hopTo.z;
                this.scene.events.game.emit("hop_landed", {
                    tx: this._tileX, tz: this._tileZ,
                });
                if (this._queued) {
                    var q = this._queued;
                    this._queued = null;
                    this._beginHop(q);
                }
            }
        } else {
            // While idle, honour any platform velocity pushed by the match
            // system (log riding). The system sets _hopPlatformV each tick
            // while the player stands on a moving log.
            var pv = this.scene._hopPlatformV;
            if (pv) {
                var pos2 = this.entity.transform.position;
                pos2.x += (pv.x || 0) * dt;
                pos2.z += (pv.z || 0) * dt;
                this.entity.transform.markDirty && this.entity.transform.markDirty();
            }
        }

        // Smooth yaw toward facing target.
        var curYaw = this.entity.transform.getRotationEuler
            ? this.entity.transform.getRotationEuler().y
            : 0;
        var dy = this._facingYaw - curYaw;
        while (dy > Math.PI) dy -= 2 * Math.PI;
        while (dy < -Math.PI) dy += 2 * Math.PI;
        curYaw += dy * Math.min(1, this._turnSpeed * dt);
        this.entity.transform.setRotationEuler(0, curYaw, 0);

        this.scene._tileHopperState = this._buildState(this._hopping);
    }

    _beginHop(intent) {
        var cur = this.entity.transform.position;
        this._tileX += intent.dx;
        this._tileZ += intent.dz;
        this._hopFrom = { x: cur.x, y: cur.y, z: cur.z };
        this._hopTo = {
            x: this._tileX * this._tileSize,
            y: this._restHeight,
            z: this._tileZ * this._tileSize,
        };
        this._hopping = true;
        this._hopT = 0;
        this._facingYaw = intent.yaw;
        // Snapshot any platform velocity into a persistent offset so the
        // hop carries cleanly — the player doesn't jerk off the log.
        var pv = this.scene._hopPlatformV;
        if (pv) {
            this._platformOffsetX = 0;
            this._platformOffsetZ = 0;
        }
        this.scene.events.game.emit("hop_start", {
            dx: intent.dx, dz: intent.dz,
            tx: this._tileX, tz: this._tileZ,
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/click_004.ogg", 0.35);
    }

    _edge(now, key) {
        var res = now && !this._prev[key];
        this._prev[key] = now;
        return res;
    }

    _buildState(hopping) {
        var pos = this.entity.transform.position;
        return {
            tileX: this._tileX,
            tileZ: this._tileZ,
            x: pos.x, y: pos.y, z: pos.z,
            hopping: hopping,
            hopPhase: hopping ? Math.min(1, this._hopT / this._hopSeconds) : 0,
            facingYaw: this._facingYaw,
        };
    }
}
