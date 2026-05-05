// also: first person view, mouse look, head bob, aim, pitch yaw
// FPS camera — attached to the camera entity, follows the player in first person
class CameraFPSBehavior extends GameScript {
    _behaviorName = "fps_camera";
    _pitchDeg = 0;
    _yawDeg = 0;
    _sensitivity = 0.15;
    _eyeHeight = 1.6;
    _matchOver = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("match_ended", function() { self._matchOver = true; });
        this.scene.events.game.on("match_started", function() { self._matchOver = false; });
        // Spawn-orientation hook: gameplay systems emit `set_camera_yaw`
        // with { yaw: <degrees>, pitch?: <degrees> } to point the camera
        // at a known direction at spawn (e.g. liminal_loop's corridor
        // runs along +X, so a fresh player needs yaw=90 to face the far
        // end). The camera otherwise owns its own _yawDeg and ignores
        // writes to scene._fpsYaw.
        this.scene.events.game.on("set_camera_yaw", function(d) {
            if (!d || typeof d.yaw !== "number") return;
            self._yawDeg = d.yaw;
            if (typeof d.pitch === "number") self._pitchDeg = d.pitch;
        });
    }

    onUpdate(dt) {
        // Freeze between matches — the game-over screen shows the
        // virtual cursor and clicks are for the Play Again / Main
        // Menu buttons, not camera aim.
        if (this._matchOver) return;

        var player = this._findLocalPlayer();
        if (!player) return;

        // Tell the engine which entity this camera is following. Scene's
        // hideFromOwner pass walks `_cameraFollowsId` from the active
        // camera so the player's mesh is suppressed deterministically —
        // before this hint, the engine relied on a geometric "is the
        // camera inside the player's collider" test that briefly fails
        // at sprint speeds when the camera lags behind the player
        // by more than the AABB pad, producing a 1-frame body flicker.
        // The id is stable across the match, but re-publishing on each
        // tick covers the case where _findLocalPlayer returned null on
        // the first frame (player hadn't spawned yet).
        this.entity._cameraFollowsId = player.id;

        var delta = this.input.getMouseDelta();
        this._yawDeg += delta.x * this._sensitivity;
        this._pitchDeg -= delta.y * this._sensitivity;
        if (this._pitchDeg > 89) this._pitchDeg = 89;
        if (this._pitchDeg < -89) this._pitchDeg = -89;

        var pp = player.transform.position;
        this.scene.setPosition(this.entity.id, pp.x, pp.y + this._eyeHeight, pp.z);

        var pitchRad = this._pitchDeg * Math.PI / 180;
        var yawRad = this._yawDeg * Math.PI / 180;
        var lookX = pp.x + Math.sin(yawRad) * Math.cos(pitchRad);
        var lookY = pp.y + this._eyeHeight + Math.sin(pitchRad);
        var lookZ = pp.z - Math.cos(yawRad) * Math.cos(pitchRad);
        this.entity.transform.lookAt(lookX, lookY, lookZ);

        // Share yaw with player movement and pitch with weapon aim. The
        // weapon behaviors (fps_combat, fps_melee_bow) need pitch to
        // shoot where the crosshair points; without the shared write
        // their fallback path resolves pitch=0 and the bullets always
        // travel horizontally regardless of where the player is looking.
        this.scene._fpsYaw = this._yawDeg;
        this.scene._fpsPitch = this._pitchDeg;
    }

    _findLocalPlayer() {
        // Multiplayer: prefer the player entity with isLocalPlayer=true on
        // its NetworkIdentity. Remote player proxies share the "player" tag
        // but get isLocalPlayer=false, so the camera would otherwise snap
        // to a random peer. Falls back to findEntityByName for single-player
        // templates that don't attach a network block.
        if (this.scene.findEntitiesByTag) {
            var players = this.scene.findEntitiesByTag("player");
            if (players && players.length > 0) {
                for (var i = 0; i < players.length; i++) {
                    var p = players[i];
                    var tags = p.tags;
                    var hasRemote = false;
                    if (tags) {
                        if (typeof tags.has === "function") hasRemote = tags.has("remote");
                        else if (tags.indexOf) hasRemote = tags.indexOf("remote") >= 0;
                    }
                    if (hasRemote) continue;
                    var ni = p.getComponent ? p.getComponent("NetworkIdentityComponent") : null;
                    if (ni && ni.isLocalPlayer) return p;
                    if (!ni) return p;
                }
            }
        }
        return this.scene.findEntityByName ? this.scene.findEntityByName("Player") : null;
    }
}
