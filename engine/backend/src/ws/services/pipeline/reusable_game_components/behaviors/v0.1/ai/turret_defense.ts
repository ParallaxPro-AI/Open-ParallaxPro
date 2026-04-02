// Turret defense — stationary defense that auto-targets and fires at enemies
class TurretDefenseBehavior extends GameScript {
    _behaviorName = "turret_defense";
    _damage = 15; _range = 15; _fireRate = 1.5; _cooldown = 0; _team = "player";
    onUpdate(dt) { this._cooldown -= dt; if (this._cooldown > 0) return;
        var pos = this.entity.transform.position; var enemies = this.scene.findEntitiesByTag("enemy") || [];
        var best = null, bestD = this._range + 1;
        for (var i = 0; i < enemies.length; i++) { if (!enemies[i].active) continue; var ep = enemies[i].transform.position; var d = Math.sqrt((pos.x-ep.x)*(pos.x-ep.x)+(pos.z-ep.z)*(pos.z-ep.z)); if (d < bestD) { bestD = d; best = enemies[i]; } }
        if (best) { this._cooldown = this._fireRate; this.entity.transform.lookAt(best.transform.position.x, best.transform.position.y, best.transform.position.z);
            this.scene.events.game.emit("entity_damaged", { targetId: best.id, damage: this._damage, source: this._team });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/sci_fi_sounds/laserSmall_000.ogg", 0.25); }
    }
}
