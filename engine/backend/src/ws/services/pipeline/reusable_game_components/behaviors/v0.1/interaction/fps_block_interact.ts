// also: mining, block-placing, voxel, destructible, survival
// FPS block interact — mine/place blocks in first person
class FPSBlockInteractBehavior extends GameScript {
    _behaviorName = "fps_block_interact";
    _mineRange = 5;
    _placeRange = 6;
    _mineTime = 1.0;
    _mining = false;
    _mineProgress = 0;
    _mineTarget = null;

    onUpdate(dt) {
        if (this.input.isKeyDown("MouseRight") || this.input.isKeyDown("KeyE")) {
            if (!this._mining) this._findTarget();
            if (this._mining && this._mineTarget) {
                this._mineProgress += dt;
                if (this._mineProgress >= this._mineTime) {
                    this.scene.events.game.emit("block_mined", { entityId: this._mineTarget.id });
                    this._mineTarget.active = false;
                    this._mining = false; this._mineTarget = null; this._mineProgress = 0;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/chop.ogg", 0.4);
                }
            }
        } else { this._mining = false; this._mineTarget = null; this._mineProgress = 0; }
    }

    _findTarget() {
        var pos = this.entity.transform.position;
        var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
        var dX = Math.sin(yaw), dZ = -Math.cos(yaw);
        var tags = ["block", "tree", "ore", "resource"];
        var best = null, bestD = this._mineRange + 1;
        for (var t = 0; t < tags.length; t++) {
            var ents = this.scene.findEntitiesByTag(tags[t]) || [];
            for (var i = 0; i < ents.length; i++) {
                if (!ents[i].active) continue;
                var ep = ents[i].transform.position;
                var dx = ep.x - pos.x, dz = ep.z - pos.z;
                var dist = Math.sqrt(dx*dx + dz*dz);
                if (dist > this._mineRange) continue;
                var dot = dist > 0.1 ? (dx*dX + dz*dZ)/dist : 1;
                if (dot > 0.5 && dist < bestD) { bestD = dist; best = ents[i]; }
            }
        }
        if (best) { this._mining = true; this._mineTarget = best; this._mineProgress = 0; }
    }
}
