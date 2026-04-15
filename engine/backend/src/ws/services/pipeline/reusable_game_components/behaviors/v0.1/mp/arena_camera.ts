// Top-down camera that follows the local player's entity. Works in both
// single-player and multiplayer — the "local player" is determined by the
// NetworkIdentityComponent.isLocalPlayer flag when multiplayer is active,
// otherwise it falls back to any entity tagged "player".
class ArenaCameraBehavior extends GameScript {
    _behaviorName = "arena_camera";
    _height = 22;

    onUpdate() {
        var target = this._findLocalPlayer();
        if (!target) return;
        var tpos = target.transform ? target.transform.position : null;
        if (!tpos) return;
        var cpos = this.entity.transform.position;
        cpos.x = tpos.x;
        cpos.y = this._height;
        cpos.z = tpos.z + 0.01;  // small offset keeps camera aimed at target
        this.entity.transform.setRotationEuler(-Math.PI / 2, 0, 0);
        this.entity.transform.markDirty && this.entity.transform.markDirty();
    }

    _findLocalPlayer() {
        // Prefer the entity flagged as local player via network identity.
        var scene = this.scene;
        var all = scene.findEntitiesByTag ? scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            var ni = e.getComponent ? e.getComponent("NetworkIdentityComponent") : null;
            if (!ni) return e;  // single-player fallback
            if (ni.isLocalPlayer) return e;
        }
        return all[0] || null;
    }
}
