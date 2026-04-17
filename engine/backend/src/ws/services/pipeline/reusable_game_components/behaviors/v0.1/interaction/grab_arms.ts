// Grab arms — Human-Fall-Flat-style hand control. Hold LMB to grip
// with the left hand, RMB for the right. While a hand is gripping,
// it stays anchored to whatever it caught (a ledge, a wall panel,
// or a carryable cube tagged `nj_grabbable`). The match system
// reads `scene._njGrabbing` to decide if climb assist + carry pull
// should be active for the local player.
//
// Implementation: each frame the local player raycasts forward from
// their chest. If LMB is just-pressed and the ray hits a grabbable
// entity within range, we anchor that hand. While anchored, we set
// `scene._njGrabbing = true` so floppy_walker injects climb assist
// (gentle upward pull). Releasing the button clears the anchor.
//
// Carrying objects: if the anchored entity has tag `nj_carryable`,
// the match system listens for `nj_grab_started` with kind="carry"
// and pulls that entity to track the player chest.
//
// Reusable beyond Noodle Jaunt: any physics platformer wanting a
// "hand-grab" verb. Tune `_reach` for arm length, `_armSpread` for
// L/R offset.
class GrabArmsBehavior extends GameScript {
    _behaviorName = "grab_arms";

    _reach = 1.7;             // raycast length from chest
    _armSpread = 0.35;        // L/R offset for the two raycasts
    _chestHeight = 1.1;
    _matchOver = false;

    _leftAnchor = null;       // { entityId, kind, point:{x,y,z} } or null
    _rightAnchor = null;

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended",   function() { self._matchOver = true; self._releaseAll(); });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; self._releaseAll(); });
        this.scene._njGrabbing = false;
    }

    onUpdate(dt) {
        if (this._matchOver) return;
        var ni = this.entity.getComponent
            ? this.entity.getComponent("NetworkIdentityComponent")
            : null;
        if (ni && !ni.isLocalPlayer) return;

        var lDown = this.input.isKeyDown && this.input.isKeyDown("MouseLeft");
        var rDown = this.input.isKeyDown && this.input.isKeyDown("MouseRight");
        var lPressed = this.input.isKeyPressed && this.input.isKeyPressed("MouseLeft");
        var rPressed = this.input.isKeyPressed && this.input.isKeyPressed("MouseRight");

        // Try to grab on press; release on key-up.
        if (lPressed) this._tryGrab("left");
        else if (!lDown && this._leftAnchor) this._releaseHand("left");

        if (rPressed) this._tryGrab("right");
        else if (!rDown && this._rightAnchor) this._releaseHand("right");

        // Range / target validity check — if the anchored target moved
        // out of range or got destroyed, drop the grip.
        this._validateAnchor("left");
        this._validateAnchor("right");

        // Publish global grabbing state for floppy_walker climb assist.
        this.scene._njGrabbing = !!(this._leftAnchor || this._rightAnchor);
    }

    _tryGrab(hand) {
        if ((hand === "left"  && this._leftAnchor) ||
            (hand === "right" && this._rightAnchor)) return;
        var pos = this.entity.transform.position;
        // Camera yaw drives our chest-forward direction.
        var yawDeg = (this.scene._tpYaw != null) ? this.scene._tpYaw : 0;
        var yaw = yawDeg * Math.PI / 180;
        var fwdX =  Math.sin(yaw);
        var fwdZ = -Math.cos(yaw);
        var sideX =  Math.cos(yaw) * (hand === "left" ? -1 : 1);
        var sideZ =  Math.sin(yaw) * (hand === "left" ? -1 : 1);
        var ox = pos.x + sideX * this._armSpread;
        var oy = pos.y + this._chestHeight;
        var oz = pos.z + sideZ * this._armSpread;
        if (!this.scene.raycast) return;
        var hit = this.scene.raycast(ox, oy, oz, fwdX, 0, fwdZ, this._reach, this.entity.id);
        if (!hit || !hit.entityId) return;
        var ent = this.scene.getEntity ? this.scene.getEntity(hit.entityId) : null;
        if (!ent) return;
        var tags = ent.tags;
        var has = function(t) {
            if (!tags) return false;
            if (typeof tags.has === "function") return tags.has(t);
            if (tags.indexOf) return tags.indexOf(t) >= 0;
            return false;
        };
        var kind = "";
        if (has("nj_carryable"))      kind = "carry";
        else if (has("nj_grabbable")) kind = "grab";   // ledges, walls
        else if (has("wall"))         kind = "grab";   // generic walls also work
        else                          return;          // not grabbable

        var anchor = {
            entityId: hit.entityId,
            kind: kind,
            point: hit.point ? { x: hit.point.x, y: hit.point.y, z: hit.point.z } : { x: ox + fwdX * 0.5, y: oy, z: oz + fwdZ * 0.5 },
        };
        if (hand === "left") this._leftAnchor = anchor;
        else                 this._rightAnchor = anchor;

        this.scene.events.game.emit("nj_grab_started", {
            peerId: this.scene._mp ? this.scene._mp.localPeerId : "",
            hand: hand,
            kind: kind,
        });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/click_001.ogg", 0.3);
    }

    _releaseHand(hand) {
        if (hand === "left") this._leftAnchor = null;
        else                 this._rightAnchor = null;
        this.scene.events.game.emit("nj_grab_released", {
            peerId: this.scene._mp ? this.scene._mp.localPeerId : "",
            hand: hand,
        });
    }

    _releaseAll() {
        if (this._leftAnchor)  this._releaseHand("left");
        if (this._rightAnchor) this._releaseHand("right");
    }

    _validateAnchor(hand) {
        var a = (hand === "left") ? this._leftAnchor : this._rightAnchor;
        if (!a) return;
        var ent = this.scene.getEntity ? this.scene.getEntity(a.entityId) : null;
        if (!ent) { this._releaseHand(hand); return; }
        var pos = this.entity.transform.position;
        var dx = a.point.x - pos.x;
        var dy = (a.point.y - pos.y - this._chestHeight);
        var dz = a.point.z - pos.z;
        var d2 = dx * dx + dy * dy + dz * dz;
        // Allow grip up to 1.6× reach before it breaks — gives a bit
        // of stretch while climbing.
        var max = this._reach * 1.6;
        if (d2 > max * max) this._releaseHand(hand);
    }
}
