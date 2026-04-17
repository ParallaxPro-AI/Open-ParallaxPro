// Light trail emitter — paints a glowing wall behind every bike.
//
// Remote-player prefabs spawn with skipBehaviors:true (see
// default_network_adapter.ts), so behaviors attached to those entities
// never tick. To render trails for remote bikes the emitter iterates
// over EVERY bike from the single local-bike instance that does run —
// one client, one emitter, every trail.
//
// Collision is still owned by the match system's own trail list. This
// behavior is purely cosmetic: the segments are render-only cubes tagged
// with "trail" and "trail_<peerId>" for cleanup on round reset.
class LightTrailEmitterBehavior extends GameScript {
    _behaviorName = "light_trail_emitter";
    _wallHeight = 1.6;
    _wallThickness = 0.3;
    _minSegmentLen = 0.4;
    _renderOnly = true;
    // Per-frame jumps bigger than this look like teleports (respawn,
    // snapshot correction, etc.) and must not paint a segment — otherwise
    // the emitter draws a ghost line from a bike's crashed position to its
    // new spawn when the network snapshot finally catches up.
    _teleportSqThreshold = 16;

    // Per-peer state: peerId -> { segments, lastX, lastZ, initialized, alive, color }
    _bikes = {};

    onStart() {
        var self = this;
        this.scene.events.game.on("round_started", function() {
            self._clearAll();
        });
        // Clear again at round end, so stale trails never outlive the
        // intermission HUD. The round_started handler above is the
        // primary cleanup, but on flaky networks round_started can
        // arrive late on the non-host; round_ended usually arrives first.
        this.scene.events.game.on("round_ended", function() {
            self._clearAll();
        });
        this.scene.events.game.on("net_round_ended", function() {
            self._clearAll();
        });
        this.scene.events.game.on("match_started", function() {
            self._clearAll();
        });
        this.scene.events.game.on("bike_crashed", function(d) {
            if (!d || !d.peerId) return;
            var st = self._bikes[d.peerId];
            if (st) st.alive = false;
        });
        this.scene.events.game.on("net_bike_crashed", function(evt) {
            var d = (evt && evt.data) || {};
            if (!d.peerId) return;
            var st = self._bikes[d.peerId];
            if (st) st.alive = false;
        });
    }

    onUpdate(dt) {
        var bikes = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("bike") : [];
        var nc = this.scene._neonCycles || {};
        var colorByPeer = nc.colorByPeer || {};
        var bikeRegistry = nc.bikes || {};

        for (var i = 0; i < bikes.length; i++) {
            var b = bikes[i];
            var ni = b.getComponent ? b.getComponent("NetworkIdentityComponent") : null;
            var pid = ni && ni.ownerId;
            if (!pid || typeof pid !== "string") continue;
            if (!b.transform) continue;

            var st = this._bikes[pid];
            if (!st) {
                st = { segments: [], lastX: 0, lastZ: 0, initialized: false, alive: true, color: [1, 1, 1, 1] };
                this._bikes[pid] = st;
            }

            // Lazy colour read — the match system may fill colorByPeer
            // after our onStart, so re-sample each tick (cheap map lookup).
            if (colorByPeer[pid]) {
                var c = colorByPeer[pid];
                st.color = [c[0], c[1], c[2], c[3] != null ? c[3] : 1];
            }

            // Mirror the bike registry's alive flag. The local bike's control
            // behavior writes it; remote bikes have their flag flipped via
            // the net_bike_crashed handler above (since their behaviors
            // don't tick on this client).
            var entry = bikeRegistry[pid];
            if (entry && typeof entry.alive === "boolean") st.alive = entry.alive;
            if (!st.alive) continue;

            var p = b.transform.position;
            if (!st.initialized) {
                st.lastX = p.x;
                st.lastZ = p.z;
                st.initialized = true;
                continue;
            }

            var dx = p.x - st.lastX;
            var dz = p.z - st.lastZ;
            var distSq = dx * dx + dz * dz;
            var minSq = this._minSegmentLen * this._minSegmentLen;
            if (distSq < minSq) continue;
            if (distSq > this._teleportSqThreshold) {
                // Respawn/teleport: advance the anchor without drawing so we
                // don't paint a line across the arena from the bike's old
                // position to the new one.
                st.lastX = p.x;
                st.lastZ = p.z;
                continue;
            }

            this._spawnSegment(pid, st, st.lastX, st.lastZ, p.x, p.z);
            st.lastX = p.x;
            st.lastZ = p.z;
        }
    }

    _spawnSegment(peerId, st, x1, z1, x2, z2) {
        var scene = this.scene;
        if (!scene.createEntity) return;
        var dx = x2 - x1;
        var dz = z2 - z1;
        var len = Math.sqrt(dx * dx + dz * dz);
        if (len < 0.01) return;
        var midX = (x1 + x2) * 0.5;
        var midZ = (z1 + z2) * 0.5;
        // Atan2 (dx, dz) — same convention as the bike (yaw 0 = +Z).
        // setRotationEuler takes degrees, so convert before applying below.
        var yawDeg = Math.atan2(dx, dz) * 180 / Math.PI;

        var name = "Trail_" + peerId.slice(0, 6) + "_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
        var id = scene.createEntity(name);
        if (id == null) return;
        scene.setPosition(id, midX, this._wallHeight * 0.5, midZ);
        scene.setScale && scene.setScale(id, this._wallThickness, this._wallHeight, len + 0.05);
        scene.addComponent(id, "MeshRendererComponent", {
            meshType: "cube",
            baseColor: st.color,
        });
        var ent = scene.findEntityByName ? scene.findEntityByName(name) : null;
        if (ent && ent.transform && ent.transform.setRotationEuler) {
            ent.transform.setRotationEuler(0, yawDeg, 0);
            ent.transform.markDirty && ent.transform.markDirty();
        }
        if (scene.addTag) {
            scene.addTag(id, "trail");
            scene.addTag(id, "trail_" + peerId);
        }
        st.segments.push(id);
    }

    _clearAll() {
        // Primary path: destroy segments we tracked per-peer.
        for (var pid in this._bikes) {
            var st = this._bikes[pid];
            this._clearSegments(st.segments);
            st.segments = [];
            st.initialized = false;
            st.alive = true;
        }
        // Belt-and-suspenders sweep: any entity still tagged "trail" in the
        // scene is an old segment we somehow lost track of (e.g. state got
        // reset mid-round, or a previous _clearAll raced with a spawn).
        // Without this sweep, stale trails from a prior round remain visible.
        var scene = this.scene;
        if (scene.findEntitiesByTag && scene.destroyEntity) {
            var orphans = scene.findEntitiesByTag("trail") || [];
            for (var i = 0; i < orphans.length; i++) {
                var o = orphans[i];
                var id = (o && o.id != null) ? o.id : o;
                try { scene.destroyEntity(id); } catch (e) { /* already gone */ }
            }
        }
    }

    _clearSegments(segments) {
        var scene = this.scene;
        for (var i = 0; i < segments.length; i++) {
            var id = segments[i];
            try {
                if (scene.destroyEntity) scene.destroyEntity(id);
            } catch (e) { /* may already be gone */ }
        }
    }

    onDestroy() {
        this._clearAll();
    }
}
