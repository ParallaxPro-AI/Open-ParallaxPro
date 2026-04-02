// Melee combat — left click to attack with cooldown, damage nearby enemies
class MeleeCombatBehavior extends GameScript {
    _behaviorName = "melee_combat";
    _damage = 15;
    _attackRange = 3;
    _attackRate = 0.5;
    _knockback = 5;
    _cooldown = 0;

    onUpdate(dt) {
        this._cooldown -= dt;
        if (this.input.isKeyPressed("MouseLeft") && this._cooldown <= 0) {
            this._cooldown = this._attackRate;
            this._attack();
        }
    }

    _attack() {
        var pos = this.entity.transform.position;
        var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
        var dirX = Math.sin(yaw);
        var dirZ = -Math.cos(yaw);

        var enemies = this.scene.findEntitiesByTag("hostile") || [];
        var animals = this.scene.findEntitiesByTag("animal") || [];
        var targets = enemies.concat(animals);

        for (var i = 0; i < targets.length; i++) {
            if (!targets[i].active) continue;
            var tp = targets[i].transform.position;
            var dx = tp.x - pos.x;
            var dz = tp.z - pos.z;
            var dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > this._attackRange) continue;
            var dot = dist > 0.1 ? (dx * dirX + dz * dirZ) / dist : 1;
            if (dot > 0.5) {
                this.scene.events.game.emit("entity_damaged", { targetId: targets[i].id, damage: this._damage, source: "player" });
                if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.4);
                break;
            }
        }
        if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/cloth1.ogg", 0.25);
    }
}
