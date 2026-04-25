// also: livestock, crop animal, passive creature, harvestable NPC, domestic beast
// Farm animal AI — passive wandering near spawn point, can be harvested
class FarmAnimalAIBehavior extends GameScript {
    _behaviorName = "farm_animal_ai";
    _speed = 1.5;
    _wanderRadius = 8;
    _health = 20;
    _targetX = 0; _targetZ = 0; _moveTimer = 0; _startX = 0; _startZ = 0; _dead = false;

    onStart() {
        var p = this.entity.transform.position;
        this._startX = p.x; this._startZ = p.z; this._pickTarget();
        var self = this;
        this.scene.events.game.on("entity_damaged", function(d) {
            if (d.targetId !== self.entity.id) return;
            self._health -= d.damage || 0;
            if (self._health <= 0) { self._dead = true; self.entity.active = false; self.scene.events.game.emit("entity_killed", { entityId: self.entity.id }); }
        });
    }

    _pickTarget() { this._targetX = this._startX + (Math.random()-0.5)*this._wanderRadius*2; this._targetZ = this._startZ + (Math.random()-0.5)*this._wanderRadius*2; this._moveTimer = 3+Math.random()*5; }

    onUpdate(dt) {
        if (this._dead) return;
        this._moveTimer -= dt;
        if (this._moveTimer <= 0) this._pickTarget();
        var p = this.entity.transform.position;
        var dx = this._targetX-p.x, dz = this._targetZ-p.z, dist = Math.sqrt(dx*dx+dz*dz);
        if (dist > 1) {
            var ux = dx/dist, uz = dz/dist, step = this._speed*dt;
            // Wall guard so kinematic farm animals don't teleport through
            // walls/fences. Skip the step (and re-target next tick) if
            // raycast hits world geometry.
            var blocked = false;
            if (this.scene.raycast) {
                var hit = this.scene.raycast(p.x, p.y+0.6, p.z, ux, 0, uz, step+0.7);
                if (hit && hit.entityId !== this.entity.id) { blocked = true; this._moveTimer = 0; }
            }
            if (!blocked) {
                this.scene.setPosition(this.entity.id, p.x+ux*step, p.y, p.z+uz*step);
            }
            this.entity.transform.setRotationEuler(0, Math.atan2(-dx,-dz)*180/Math.PI, 0);
            if (this.entity.playAnimation) this.entity.playAnimation(this._walkAnim || "Walk", { loop: true });
        } else { if (this.entity.playAnimation) this.entity.playAnimation("Idle", { loop: true }); }
    }
}
