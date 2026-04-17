// Invader Ship — retro side-to-side player ship with a single fire
// button. Arrow keys / A-D drive the ship left and right along a fixed
// z; Space fires a bullet upward, rate-limited to N on screen at once
// (the match system owns the bullet pool + damage).
//
// Fires:
//   invader_fire_pressed  — system spawns a bullet (if cap not reached)
//
// Scene contract:
//   scene._invaderFrozen       true while intro / death / wave clear
//                              or game-over is showing
//   entity._invaderAlive       system toggles during hit-stun
//   scene._invaderPlayerDir    last direction the ship moved (for vfx)
//
// Reusable for any 2D-style shooter with a locked-axis player — tune
// speed / bounds / fire-key / cooldown via behavior params.
class InvaderShipBehavior extends GameScript {
    _behaviorName = "invader_ship";

    _speed = 14;
    _boundsHalfX = 18;
    _fixedY = 1;
    _fixedZ = 0;
    _fireCooldown = 0.25;
    _prevFire = false;
    _fireTimer = 0;

    onUpdate(dt) {
        if (this._fireTimer > 0) this._fireTimer = Math.max(0, this._fireTimer - dt);

        if (this.scene._invaderFrozen) return;
        if (this.entity._invaderAlive === false) return;

        var left = this.input.isKeyDown("KeyA") || this.input.isKeyDown("ArrowLeft");
        var right = this.input.isKeyDown("KeyD") || this.input.isKeyDown("ArrowRight");
        var dx = (right ? 1 : 0) - (left ? 1 : 0);
        var pos = this.entity.transform.position;

        pos.x += dx * this._speed * dt;
        if (pos.x < -this._boundsHalfX) pos.x = -this._boundsHalfX;
        if (pos.x >  this._boundsHalfX) pos.x =  this._boundsHalfX;
        // Keep y/z pinned so physics never nudges us off the axis.
        pos.y = this._fixedY;
        pos.z = this._fixedZ;

        this.entity.transform.markDirty && this.entity.transform.markDirty();
        this.scene._invaderPlayerDir = dx;

        // Fire — cooldown prevents auto-hold spam without actually
        // rate-capping the per-second count; the system itself can also
        // cap total bullets on screen.
        var firing = this.input.isKeyDown("Space") || this.input.isKeyDown("MouseLeft");
        if (firing && !this._prevFire && this._fireTimer <= 0) {
            this._fireTimer = this._fireCooldown;
            this.scene.events.game.emit("invader_fire_pressed", {
                x: pos.x, z: pos.z,
            });
        }
        this._prevFire = firing;
    }
}
