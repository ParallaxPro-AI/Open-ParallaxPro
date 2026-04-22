// also: twin-stick, top-down shooter, directional fire, projectile system
// Top-down tear shooter — twin-stick fire on the arrow keys (or
// optionally LMB to fire toward the cursor). Each shot fires a tear
// projectile in the chosen cardinal direction (or diagonal when two
// keys are held). Tears are short-lived dynamic spheres; the match
// system listens for cp_tear_fired and owns the spawn + flight.
//
// Reusable beyond Cellar Purge: any twin-stick shooter where the gun
// is direction-locked rather than camera-aimed. Tune `_fireRate` for
// the gun feel, hand `_lookAround` to the match system for ranged
// stat boosts.
class TopdownTearShooterBehavior extends GameScript {
    _behaviorName = "topdown_tear_shooter";

    _fireRate = 0.32;          // seconds between shots
    _matchOver = false;
    _fireTimer = 0;

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended",   function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
    }

    onUpdate(dt) {
        if (this._matchOver) return;
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        this._fireTimer -= dt;

        // Twin-stick fire: arrow keys give a directional aim. Multiple
        // keys held = diagonal. The match system reads our local fire
        // rate from the scene (it can apply pickups that buff it).
        var dx = 0, dz = 0;
        if (this.input.isKeyDown("ArrowUp"))    dz -= 1;
        if (this.input.isKeyDown("ArrowDown"))  dz += 1;
        if (this.input.isKeyDown("ArrowLeft"))  dx -= 1;
        if (this.input.isKeyDown("ArrowRight")) dx += 1;

        if (dx === 0 && dz === 0) return;
        // Effective fire rate respects scene-level buffs the match
        // system stores (each buff reduces the cooldown).
        var effRate = this.scene._cpFireRate || this._fireRate;
        if (this._fireTimer > 0) return;
        this._fireTimer = effRate;

        var len = Math.sqrt(dx * dx + dz * dz);
        if (len > 0) { dx /= len; dz /= len; }

        this.scene.events.game.emit("cp_tear_fired", { dirX: dx, dirZ: dz });
    }
}
