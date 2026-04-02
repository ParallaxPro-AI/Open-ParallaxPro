// Ranged combat — auto-targets nearest enemy in range and fires
class RangedCombatBehavior extends GameScript {
    _behaviorName = "ranged_combat"; _damage = 12; _range = 20; _fireRate = 1.0; _cooldown = 0; _health = 80; _speed = 3; _dead = false; _currentAnim = "";
    onStart() { var self = this; this.scene.events.game.on("entity_damaged", function(d) { if (d.targetId!==self.entity.id) return; self._health-=d.damage||0; if (self._health<=0) { self._dead=true; self.entity.active=false; self.scene.events.game.emit("entity_killed",{entityId:self.entity.id,team:"player"}); } }); }
    onUpdate(dt) { if (this._dead) return; this._cooldown -= dt;
        var p = this.entity.transform.position; var enemies = this.scene.findEntitiesByTag("enemy") || [];
        var best = null, bestD = this._range + 1;
        for (var i = 0; i < enemies.length; i++) { if (!enemies[i].active) continue; var ep = enemies[i].transform.position; var d = Math.sqrt((p.x-ep.x)*(p.x-ep.x)+(p.z-ep.z)*(p.z-ep.z)); if (d < bestD) { bestD = d; best = enemies[i]; } }
        if (best) { this.entity.transform.lookAt(best.transform.position.x, p.y, best.transform.position.z);
            if (this._cooldown <= 0) { this._cooldown = this._fireRate; this.scene.events.game.emit("entity_damaged", { targetId: best.id, damage: this._damage, source: "player" });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_002.ogg", 0.25); } this._playAnim("Idle"); }
        else { this._playAnim("Idle"); }
    }
    _playAnim(n) { if (this._currentAnim===n) return; this._currentAnim=n; if (this.entity.playAnimation) this.entity.playAnimation(n,{loop:true}); }
}
