// also: voxel, sandboxing, resource gathering, placement system, destruction
// Block interact — mine and place blocks in the world
class BlockInteractBehavior extends GameScript {
    _behaviorName = "block_interact";
    _mineRange = 4;
    _placeRange = 5;
    _mineTime = 1.2;
    _mining = false;
    _mineTarget = null;
    _mineProgress = 0;

    onUpdate(dt) {
        // Right click — interact/mine nearest block
        if (this.input.isKeyDown("MouseRight") || this.input.isKeyDown("KeyE")) {
            if (!this._mining) {
                this._findMineTarget();
            }
            if (this._mining && this._mineTarget) {
                this._mineProgress += dt;
                if (this._mineProgress >= this._mineTime) {
                    this.scene.events.game.emit("block_mined", {
                        entityId: this._mineTarget.id,
                        x: this._mineTarget.transform.position.x,
                        y: this._mineTarget.transform.position.y,
                        z: this._mineTarget.transform.position.z
                    });
                    this._mineTarget.active = false;
                    this._mining = false;
                    this._mineTarget = null;
                    this._mineProgress = 0;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/rpg_audio/chop.ogg", 0.4);
                }
            }
        } else {
            this._mining = false;
            this._mineTarget = null;
            this._mineProgress = 0;
        }
    }

    _findMineTarget() {
        var pos = this.entity.transform.position;
        var yaw = (this.scene._fpsYaw || 0) * Math.PI / 180;
        var dirX = Math.sin(yaw);
        var dirZ = -Math.cos(yaw);

        var blocks = this.scene.findEntitiesByTag("block") || [];
        var trees = this.scene.findEntitiesByTag("tree") || [];
        var ores = this.scene.findEntitiesByTag("ore") || [];
        var all = blocks.concat(trees).concat(ores);

        var bestDist = this._mineRange + 1;
        var best = null;
        for (var i = 0; i < all.length; i++) {
            if (!all[i].active) continue;
            var bp = all[i].transform.position;
            var dx = bp.x - pos.x;
            var dz = bp.z - pos.z;
            var dist = Math.sqrt(dx * dx + dz * dz);
            if (dist > this._mineRange) continue;
            var dot = dist > 0.1 ? (dx * dirX + dz * dirZ) / dist : 1;
            if (dot > 0.5 && dist < bestDist) {
                bestDist = dist;
                best = all[i];
            }
        }
        if (best) {
            this._mining = true;
            this._mineTarget = best;
            this._mineProgress = 0;
        }
    }
}
