// also: WASD locomotion, sprint, client-side input, multiplayer sync
// Arena player movement — client-authoritative.
//
// Each peer drives their own local player with WASD. Remote players show
// up via proxy entities spawned by the DefaultNetworkAdapter and updated
// from snapshots; they don't have this behavior attached, so this script
// never tries to move someone else's player.
//
// The local player's transform is broadcast every sim tick by the
// MultiplayerSession, so other peers see us move. Sprint holds Shift.
class PlayerArenaMovementBehavior extends GameScript {
    _behaviorName = "player_arena_movement";
    _speed = 6;
    _turnSpeed = 4;

    onUpdate(dt) {
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        // Only the local player entity reads input; proxies are driven by
        // incoming snapshots.
        if (ni && !ni.isLocalPlayer) return;

        var forward = (this.input.isKeyDown("KeyW") ? 1 : 0) - (this.input.isKeyDown("KeyS") ? 1 : 0);
        var strafe  = (this.input.isKeyDown("KeyD") ? 1 : 0) - (this.input.isKeyDown("KeyA") ? 1 : 0);
        var sprint  = this.input.isKeyDown("ShiftLeft");

        var speed = this._speed * (sprint ? 1.6 : 1);
        var pos = this.entity.transform.position;
        pos.x += strafe * speed * dt;
        pos.z -= forward * speed * dt;

        if (Math.abs(forward) + Math.abs(strafe) > 0.1) {
            var targetYaw = Math.atan2(strafe, -forward);
            var curYaw = this.entity.transform.getRotationEuler
                ? this.entity.transform.getRotationEuler().y
                : 0;
            var dYaw = targetYaw - curYaw;
            while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
            while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
            curYaw += dYaw * Math.min(1, this._turnSpeed * dt);
            this.entity.transform.setRotationEuler(0, curYaw, 0);
        }

        // Clamp to arena bounds so you can't walk out of the level.
        if (pos.x < -19) pos.x = -19;
        if (pos.x >  19) pos.x =  19;
        if (pos.z < -19) pos.z = -19;
        if (pos.z >  19) pos.z =  19;

        this.entity.transform.markDirty && this.entity.transform.markDirty();
    }
}
