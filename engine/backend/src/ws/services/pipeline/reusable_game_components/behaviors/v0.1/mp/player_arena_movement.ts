// Arena player movement. Runs on every peer for every player entity.
// - Local player: reads input directly, moves instantly (prediction).
// - Remote players on a client: reads replicated input (forwarded by the host
//   via the MultiplayerSession) so movement matches, then interpolation on
//   transform snapshots smooths out drift.
// - On the host: reads replicated input for non-local players, applies the
//   authoritative sim.
//
// The host-authoritative snapshot pipeline (MultiplayerSession) transmits the
// resulting transform every tick, so prediction errors are self-correcting.
class PlayerArenaMovementBehavior extends GameScript {
    _behaviorName = "player_arena_movement";
    _speed = 6;
    _turnSpeed = 4;

    onUpdate(dt) {
        var mp = this.scene._mp;
        var ni = this.entity.getComponent ? this.entity.getComponent("NetworkIdentityComponent") : null;
        var isLocal = !ni || ni.isLocalPlayer || !mp || !mp.isHost;

        var input = this._resolveInput(mp, ni, isLocal);
        if (!input) return;

        var forward = (input.KeyW ? 1 : 0) - (input.KeyS ? 1 : 0);
        var strafe  = (input.KeyD ? 1 : 0) - (input.KeyA ? 1 : 0);
        var sprint  = !!input.ShiftLeft;

        var speed = this._speed * (sprint ? 1.6 : 1);
        var pos = this.entity.transform.position;
        pos.x += strafe * speed * dt;
        pos.z -= forward * speed * dt;

        if (Math.abs(forward) + Math.abs(strafe) > 0.1) {
            var targetYaw = Math.atan2(strafe, -forward);
            // Smoothly turn toward movement direction
            var curYaw = this.entity.transform.getRotationEuler
                ? this.entity.transform.getRotationEuler().y
                : 0;
            var dYaw = targetYaw - curYaw;
            while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
            while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
            curYaw += dYaw * Math.min(1, this._turnSpeed * dt);
            this.entity.transform.setRotationEuler(0, curYaw, 0);
        }

        // Clamp to arena bounds — conservatively match wall layout.
        if (pos.x < -19) pos.x = -19;
        if (pos.x >  19) pos.x =  19;
        if (pos.z < -19) pos.z = -19;
        if (pos.z >  19) pos.z =  19;

        this.entity.transform.markDirty && this.entity.transform.markDirty();
    }

    _resolveInput(mp, ni, isLocal) {
        if (isLocal) {
            // Direct input read for the local player.
            return {
                KeyW: this.input.isKeyDown("KeyW"),
                KeyA: this.input.isKeyDown("KeyA"),
                KeyS: this.input.isKeyDown("KeyS"),
                KeyD: this.input.isKeyDown("KeyD"),
                ShiftLeft: this.input.isKeyDown("ShiftLeft"),
            };
        }
        // Host executing the sim for a remote player — read the input the
        // session has received from that peer.
        if (!mp || !ni || !ni.ownerId) return null;
        // ownerId is a peerId string (the new session uses strings, not numbers)
        var adapter = mp._adapter;
        if (!adapter || !adapter.getRemoteInput) return null;
        var r = adapter.getRemoteInput(ni.ownerId);
        if (!r) return null;
        return r.keys;
    }
}
