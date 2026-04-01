class EntityLabel extends GameScript {
    _el = null;
    _label = "";
    _removed = false;
    onStart() {
        if (!this.ui) { this.ui = { createText: function() { return { text: "", remove: function(){} }; }, removeElement: function(){} }; }
        this._label = this.entity.name || "Entity";
        this._el = this.ui.createText({ text: this._label, fontSize: 9, color: "#44ff66", backgroundColor: "rgba(0,0,0,0.5)", padding: 2, borderRadius: 2, x: -999, y: -999 });
        var self = this;
        this.scene.events.game.on("entity_destroyed", function(data) {
            if (data && data.entityId === self.entity.id) { self._removeLabel(); }
        });
    }
    _removeLabel() {
        if (this._removed) return;
        this._removed = true;
        if (this._el) { this._el.text = ""; if (this._el.destroy) this._el.destroy(); else if (this._el.remove) this._el.remove(); }
    }
    onUpdate(dt) {
        if (!this._el || this._removed) return;
        if (!this.entity || !this.entity.active) { this._removeLabel(); return; }
        if (!this.scene.worldToScreen) return;
        var wp = this.entity.getWorldPosition ? this.entity.getWorldPosition() : this.entity.transform.position;
        var cam = this.scene.findEntityByName("Camera") || this.scene.findEntityByName("Main Camera");
        if (cam) {
            var cp = cam.transform.position;
            var dx = wp.x - cp.x, dy = wp.y - cp.y, dz = wp.z - cp.z;
            if (dx * dx + dy * dy + dz * dz > 900) { this._el.text = ""; this._el.x = -999; this._el.y = -999; return; }
        }
        var sp = this.scene.worldToScreen(wp.x, wp.y, wp.z);
        if (!sp) { this._el.text = ""; this._el.x = -999; this._el.y = -999; return; }
        this._el.text = this._label;
        this._el.x = Math.floor(sp.x);
        this._el.y = Math.floor(sp.y);
    }
    onDestroy() { this._removeLabel(); }
}
