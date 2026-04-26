// also: first-person, dual-weapon, projectile, sword, archery, swinging
// FPS melee and bow — left click for melee swing, Q for bow shot
class FPSMeleeBowBehavior extends GameScript {
    _behaviorName = "fps_melee_bow";
    _meleeDamage = 12;
    _meleeRange = 3;
    _meleeRate = 0.4;
    _bowDamage = 25;
    _bowRange = 30;
    _bowRate = 1.5;
    _meleeCooldown = 0;
    _bowCooldown = 0;

    onUpdate(dt) {
        this._meleeCooldown -= dt;
        this._bowCooldown -= dt;
        if (this.input.isKeyPressed("MouseLeft") && this._meleeCooldown <= 0) {
            this._meleeCooldown = this._meleeRate;
            this._attack(this._meleeDamage, this._meleeRange);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/knifeSlice.ogg", 0.35);
        }
        if (this.input.isKeyPressed("KeyQ") && this._bowCooldown <= 0) {
            this._bowCooldown = this._bowRate;
            this._attack(this._bowDamage, this._bowRange);
            if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/drawKnife1.ogg", 0.4);
        }
    }

    _attack(dmg, range) {
        if (this.entity.playAnimation) this.entity.playAnimation("Attack", { loop: false });
        var pos = this.entity.transform.position;
        var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
        var dX = Math.sin(yaw), dZ = -Math.cos(yaw);
        var enemies = this.scene.findEntitiesByTag("hostile") || [];
        for (var i = 0; i < enemies.length; i++) {
            if (!enemies[i].active) continue;
            var ep = enemies[i].transform.position;
            var dx = ep.x-pos.x, dz = ep.z-pos.z;
            var dist = Math.sqrt(dx*dx+dz*dz);
            if (dist > range) continue;
            var dot = dist>0.1?(dx*dX+dz*dZ)/dist:1;
            if (dot > 0.5) {
                this.scene.events.game.emit("entity_damaged", { targetId: enemies[i].id, damage: dmg, source: "player" });
                break;
            }
        }
    }
}
