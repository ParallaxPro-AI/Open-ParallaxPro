// also: NPC behavior, AI pathfinding, enemy detection, autonomous fighter
// Unit combat — melee fighter that moves to and attacks nearest enemy
class UnitCombatBehavior extends GameScript {
    _behaviorName = "unit_combat"; _damage = 15; _attackRange = 3; _attackRate = 0.8; _speed = 4; _detectRange = 20; _health = 100; _dead = false; _cooldown = 0; _currentAnim = "";
    onStart() { var self = this; this.scene.events.game.on("entity_damaged", function(d) { if (d.targetId!==self.entity.id) return; self._health-=d.damage||0; if (self._health<=0) { self._dead=true; self.entity.active=false; self.scene.events.game.emit("entity_killed",{entityId:self.entity.id,team:"player"}); } }); }
    onUpdate(dt) { if (this._dead) return; this._cooldown -= dt;
        var p = this.entity.transform.position; var enemies = this.scene.findEntitiesByTag("enemy") || [];
        var best = null, bestD = this._detectRange + 1;
        for (var i = 0; i < enemies.length; i++) { if (!enemies[i].active) continue; var ep = enemies[i].transform.position; var d = Math.sqrt((p.x-ep.x)*(p.x-ep.x)+(p.z-ep.z)*(p.z-ep.z)); if (d < bestD) { bestD = d; best = enemies[i]; } }
        if (best) { var ep = best.transform.position; var dx = ep.x-p.x, dz = ep.z-p.z;
            this.entity.transform.setRotationEuler(0, Math.atan2(dx,dz)*180/Math.PI, 0);
            if (bestD > this._attackRange) { this.scene.setPosition(this.entity.id, p.x+(dx/bestD)*this._speed*dt, p.y, p.z+(dz/bestD)*this._speed*dt); this._playAnim("Run"); }
            else if (this._cooldown <= 0) { this._cooldown = this._attackRate; this.scene.events.game.emit("entity_damaged", { targetId: best.id, damage: this._damage, source: "player" });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.3); this._playAnim("Idle"); } }
        else { this._playAnim("Idle"); }
    }
    _playAnim(n) { if (this._currentAnim===n) return; this._currentAnim=n; if (this.entity.playAnimation) this.entity.playAnimation(n,{loop:true}); }
}
