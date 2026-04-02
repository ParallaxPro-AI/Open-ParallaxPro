// Deadly games camera — adapts per round: chase, side, or overhead view
class DeadlyCameraBehavior extends GameScript {
    _behaviorName = "camera_deadly";
    _smoothSpeed = 4;
    _camX = 0;
    _camY = 10;
    _camZ = 56;
    _lookX = 0;
    _lookY = 1;
    _lookZ = 36;

    onStart() {
        this._camX = 0;
        this._camY = 10;
        this._camZ = 56;
        this._lookX = 0;
        this._lookY = 1;
        this._lookZ = 36;
    }

    onUpdate(dt) {
        var round = this.scene._deadlyRound || 0;
        var player = this.scene.findEntityByName("Contestant");
        var targetX = 0, targetY = 10, targetZ = 56;
        var lx = 0, ly = 1, lz = 36;

        if (round >= 1 && player) {
            var pp = player.transform.position;

            if (round === 1) {
                // RLGL: chase camera behind player
                targetX = pp.x * 0.25;
                targetY = 8;
                targetZ = pp.z + 12;
                lx = pp.x * 0.3;
                ly = 1;
                lz = pp.z - 10;
            } else if (round === 2) {
                // Glass Bridge: side view tracking current panel
                var bz = this.scene._deadlyBridgeZ || 20;
                targetX = 14;
                targetY = 8;
                targetZ = bz + 2;
                lx = 0;
                ly = 3;
                lz = bz;
            } else if (round === 3) {
                // Floor Collapse: overhead
                targetX = 0;
                targetY = 22;
                targetZ = 14;
                lx = 0;
                ly = 0;
                lz = 0;
            }
        }

        // Smooth follow
        var t = 1 - Math.exp(-this._smoothSpeed * dt);
        this._camX += (targetX - this._camX) * t;
        this._camY += (targetY - this._camY) * t;
        this._camZ += (targetZ - this._camZ) * t;
        this._lookX += (lx - this._lookX) * t;
        this._lookY += (ly - this._lookY) * t;
        this._lookZ += (lz - this._lookZ) * t;

        this.scene.setPosition(this.entity.id, this._camX, this._camY, this._camZ);
        this.entity.transform.lookAt(this._lookX, this._lookY, this._lookZ);
    }
}
