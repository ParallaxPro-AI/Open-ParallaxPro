// also: WASD locomotion, sprint, client-side input, multiplayer sync
// Arena player movement — client-authoritative.
//
// Pair with `physics: dynamic` (mass 75, freeze_rotation: true, capsule)
// on the player so Rapier auto-resolves collisions against static rocks,
// walls, and props. Movement is driven by setVelocity, vy preserved from
// the rigidbody so gravity keeps the feet on the ground.
//
// Each peer drives their own local player with WASD. Remote players show
// up via proxy entities spawned by the DefaultNetworkAdapter and updated
// from snapshots; they don't have this behavior attached, so this script
// never tries to move someone else's player. (System-side
// _tickRemoteAnimations in coin_grab_game drives the proxy's anim.)
//
// The local player's transform is broadcast every sim tick by the
// MultiplayerSession, so other peers see us move. Sprint holds Shift.
class PlayerArenaMovementBehavior extends GameScript {
    _behaviorName = "player_arena_movement";
    _speed = 6;
    _turnSpeed = 4;
    _arenaHalfExtent = 19;
    _currentAnim = "";

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

        // World-space velocity. Dynamic body + setVelocity lets Rapier
        // auto-resolve collisions against static walls / props.
        var vx = strafe * speed;
        var vz = -forward * speed;

        // Soft arena clamp: kill outward velocity at the edge so the
        // player can't push off the arena. Replaces the old hard
        // pos = ±arenaHalfExtent clamp which would fight physics.
        var bound = this._arenaHalfExtent;
        if (pos.x < -bound && vx < 0) vx = 0;
        if (pos.x >  bound && vx > 0) vx = 0;
        if (pos.z < -bound && vz < 0) vz = 0;
        if (pos.z >  bound && vz > 0) vz = 0;

        // Preserve vertical velocity so gravity keeps the player on the
        // ground (and any future jump impulse survives this frame).
        var rb = this.entity.getComponent ? this.entity.getComponent("RigidbodyComponent") : null;
        var vy = (rb && rb.getLinearVelocity) ? (rb.getLinearVelocity().y || 0) : 0;
        this.scene.setVelocity(this.entity.id, { x: vx, y: vy, z: vz });

        if (Math.abs(forward) + Math.abs(strafe) > 0.1) {
            // Motion direction is (strafe, 0, -forward); the GLB's native
            // forward is -Z, so the rotation that aligns the model's nose
            // with motion is atan2(-strafe, forward). freeze_rotation:true
            // on the rigidbody keeps physics from clobbering this write.
            var targetYaw = Math.atan2(-strafe, forward);
            var curYaw = this.entity.transform.getRotationEuler
                ? this.entity.transform.getRotationEuler().y
                : 0;
            var dYaw = targetYaw - curYaw;
            while (dYaw > Math.PI) dYaw -= 2 * Math.PI;
            while (dYaw < -Math.PI) dYaw += 2 * Math.PI;
            curYaw += dYaw * Math.min(1, this._turnSpeed * dt);
            this.entity.transform.setRotationEuler(0, curYaw, 0);
        }

        // Animation hint. Threshold matches the sprint multiplier above
        // (base 6 → ~6, sprint ×1.6 → ~9.6) so the Run clip kicks in
        // only when actually sprinting.
        var moving = (Math.abs(forward) + Math.abs(strafe)) > 0.1;
        var anim = !moving ? "Idle" : (sprint ? "Run" : "Walk");
        if (anim !== this._currentAnim) {
            this._currentAnim = anim;
            if (this.entity.playAnimation) {
                try { this.entity.playAnimation(anim, { loop: true }); } catch (e) { /* missing clip */ }
            }
        }
    }
}
