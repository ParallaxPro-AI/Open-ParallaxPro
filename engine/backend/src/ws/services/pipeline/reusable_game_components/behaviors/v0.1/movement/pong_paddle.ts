// also: pong, paddle, classic-arcade, bat, vertical-movement
// Pong paddle — W/S or Arrow Up/Down to move paddle vertically
class PongPaddleBehavior extends GameScript {
    _behaviorName = "pong_paddle";
    _speed = 12;
    _minZ = -5.5;
    _maxZ = 5.5;

    onUpdate(dt) {
        var dir = 0;
        if (this.input.isKeyDown("KeyW") || this.input.isKeyDown("ArrowUp")) dir -= 1;
        if (this.input.isKeyDown("KeyS") || this.input.isKeyDown("ArrowDown")) dir += 1;

        if (dir === 0) return;

        var pos = this.entity.transform.position;
        var newZ = pos.z + dir * this._speed * dt;

        if (newZ > this._maxZ) newZ = this._maxZ;
        if (newZ < this._minZ) newZ = this._minZ;

        this.scene.setPosition(this.entity.id, pos.x, pos.y, newZ);
    }
}
