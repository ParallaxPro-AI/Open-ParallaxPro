// also: NPC behavior, settlement, wandering, patrol, townsperson
// Villager AI — friendly NPC that wanders near buildings, can be interacted with
class VillagerAIBehavior extends GameScript {
    _behaviorName = "villager_ai";
    _speed = 1.5;
    _wanderRadius = 10;
    _targetX = 0; _targetZ = 0; _moveTimer = 0; _startX = 0; _startZ = 0;

    onStart() {
        var p = this.entity.transform.position;
        this._startX = p.x; this._startZ = p.z; this._pickTarget();
    }

    _pickTarget() { this._targetX = this._startX + (Math.random()-0.5)*this._wanderRadius*2; this._targetZ = this._startZ + (Math.random()-0.5)*this._wanderRadius*2; this._moveTimer = 4+Math.random()*6; }

    onUpdate(dt) {
        this._moveTimer -= dt;
        if (this._moveTimer <= 0) this._pickTarget();
        var p = this.entity.transform.position;
        var dx = this._targetX-p.x, dz = this._targetZ-p.z, dist = Math.sqrt(dx*dx+dz*dz);
        if (dist > 1) {
            this.scene.setPosition(this.entity.id, p.x+(dx/dist)*this._speed*dt, p.y, p.z+(dz/dist)*this._speed*dt);
            this.entity.transform.setRotationEuler(0, Math.atan2(-dx,-dz)*180/Math.PI, 0);
            if (this.entity.playAnimation) this.entity.playAnimation("Walk", { loop: true });
        } else { if (this.entity.playAnimation) this.entity.playAnimation("Idle", { loop: true }); }
    }
}
