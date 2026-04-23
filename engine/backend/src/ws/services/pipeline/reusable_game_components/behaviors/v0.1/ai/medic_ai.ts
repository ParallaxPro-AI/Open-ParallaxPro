// also: support, teammate, healing, restoration, health_recovery, buff
// Medic AI — follows nearby wounded allied units and heals them
class MedicAIBehavior extends GameScript {
    _behaviorName = "medic_ai"; _speed = 3; _healRange = 4; _healRate = 2; _healAmount = 5; _health = 50; _dead = false; _healTimer = 0; _currentAnim = "";
    onStart() { var self = this; this.scene.events.game.on("entity_damaged", function(d) { if (d.targetId!==self.entity.id) return; self._health-=d.damage||0; if (self._health<=0) { self._dead=true; self.entity.active=false; } }); }
    onUpdate(dt) { if (this._dead) return; this._healTimer -= dt;
        var p = this.entity.transform.position; var allies = this.scene.findEntitiesByTag("military") || []; var best = null, bestD = 999;
        for (var i = 0; i < allies.length; i++) { if (!allies[i].active || allies[i].id === this.entity.id) continue; var ap = allies[i].transform.position; var d = Math.sqrt((p.x-ap.x)*(p.x-ap.x)+(p.z-ap.z)*(p.z-ap.z)); if (d < bestD) { bestD = d; best = allies[i]; } }
        if (best && bestD > this._healRange) { var dx = best.transform.position.x-p.x, dz = best.transform.position.z-p.z, dist = Math.sqrt(dx*dx+dz*dz);
            this.scene.setPosition(this.entity.id, p.x+(dx/dist)*this._speed*dt, p.y, p.z+(dz/dist)*this._speed*dt); this._playAnim("Walk"); }
        else if (best && bestD <= this._healRange && this._healTimer <= 0) { this._healTimer = this._healRate; this.scene.events.game.emit("entity_healed", { targetId: best.id, amount: this._healAmount }); this._playAnim("Idle"); }
        else { this._playAnim("Idle"); }
    }
    _playAnim(n) { if (this._currentAnim===n) return; this._currentAnim=n; if (this.entity.playAnimation) this.entity.playAnimation(n,{loop:true}); }
}
