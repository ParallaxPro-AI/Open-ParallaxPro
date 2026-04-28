// also: WASD locomotion, sprint, client-side input, multiplayer sync
// Arena player movement — client-authoritative.
//
// USE FOR: empty-arena MP games (top-down dome, ice rink, sky island
// with no props). Pair with `physics: kinematic` on the player.
// DO NOT USE FOR: MP worlds with static obstacles (rocks, forge, walls,
// fences, terrain features). This script writes `transform.position`
// directly, and Rapier's kinematicPositionBased body type does NOT
// auto-resolve against static colliders — the player will walk through
// every rock, building, and prop in the scene even if their physics
// blocks are correct. For obstacle-rich worlds, use a dynamic body
// (mass 75, freeze_rotation: true) + a setVelocity-driven movement
// script (e.g. `behaviors/movement/third_person_movement.ts`).
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
        pos.x += strafe * speed * dt;
        pos.z -= forward * speed * dt;

        if (Math.abs(forward) + Math.abs(strafe) > 0.1) {
            // Motion direction is (strafe, 0, -forward); the GLB's native
            // forward is -Z, so the rotation that aligns the model's nose
            // with motion is atan2(-strafe, forward). Previously this was
            // atan2(strafe, -forward), 180° off — invisible on the old
            // capsule but obvious now that the player is a Knight model.
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

        // Clamp to arena bounds so you can't walk out of the level.
        if (pos.x < -19) pos.x = -19;
        if (pos.x >  19) pos.x =  19;
        if (pos.z < -19) pos.z = -19;
        if (pos.z >  19) pos.z =  19;

        this.entity.transform.markDirty && this.entity.transform.markDirty();

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
