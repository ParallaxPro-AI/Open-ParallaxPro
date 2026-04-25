// also: harvesting, resource gathering, supply chain, labor, base return
// Worker AI — gathers resources and returns to base
class WorkerAIBehavior extends GameScript {
    _behaviorName = "worker_ai";
    _speed = 3; _gatherRange = 12; _health = 40; _dead = false; _targetX = 0; _targetZ = 0; _moving = false; _currentAnim = "";
    onStart() {
        var self = this;
        this.scene.events.game.on("entity_damaged", function(d) { if (d.targetId!==self.entity.id) return; self._health-=d.damage||0; if (self._health<=0) { self._dead=true; self.entity.active=false; self.scene.events.game.emit("entity_killed",{entityId:self.entity.id,team:"player"}); } });
    }
    onUpdate(dt) { if (this._dead) return;
        if (!this._moving) { this._targetX = this.entity.transform.position.x + (Math.random()-0.5)*this._gatherRange*2; this._targetZ = this.entity.transform.position.z + (Math.random()-0.5)*this._gatherRange*2; this._moving = true; }
        var p = this.entity.transform.position; var dx = this._targetX-p.x, dz = this._targetZ-p.z, dist = Math.sqrt(dx*dx+dz*dz);
        if (dist < 1) { this._moving = false; this._playAnim("Idle"); } else { this.scene.setPosition(this.entity.id, p.x+(dx/dist)*this._speed*dt, p.y, p.z+(dz/dist)*this._speed*dt); this.entity.transform.setRotationEuler(0, Math.atan2(-dx,-dz)*180/Math.PI, 0); this._playAnim("Walk"); }
    }
    _playAnim(n) { if (this._currentAnim===n) return; this._currentAnim=n; if (this.entity.playAnimation) this.entity.playAnimation(n,{loop:true}); }
}
