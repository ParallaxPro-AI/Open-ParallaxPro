// also: social-gameplay, free-roam, hangout, avatar-nametags
// Walk-around social MP: no match logic, no score, no respawn — just
// 1-16 players sharing a world, chatting, and seeing each other as
// named characters floating over the landscape.
//
// Handles two things the generic mp_bridge doesn't:
//   1. Local player NetworkIdentity bootstrap on match_started. The
//      asssembler plants placeholder (-2, -1) values on the world-
//      placed player entity so the runtime adapter knows it's ours;
//      we overwrite those with the real peerId + a stable networkId
//      so snapshots actually start broadcasting.
//   2. Name tags above every player (local + remote proxies). Reads
//      the roster to resolve peerId → username per frame so a rename
//      propagates immediately, and worldToScreen's null return hides
//      the label when the player is off-camera.
class WalkAroundGameSystem extends GameScript {
    _labels = {};           // entityId -> { el, username }
    _knownUsernames = {};   // peerId -> username
    _initialized = false;

    onStart() {
        var self = this;
        this._initMatch();
        this.scene.events.game.on("match_started", function() { self._initMatch(); });
    }

    onUpdate(dt) {
        if (!this._initialized) {
            this._initMatch();
            if (!this._initialized) return;
        }
        this._refreshUsernamesFromRoster();
        this._updateLabels();
    }

    _initMatch() {
        var mp = this.scene._mp;
        if (!mp || !mp.localPeerId) return;
        var player = this._findLocalPlayerEntity();
        if (!player) return;
        var ni = player.getComponent("NetworkIdentityComponent");
        if (!ni) return;
        ni.networkId = this._hashPeerId(mp.localPeerId);
        ni.ownerId = mp.localPeerId;
        ni.isLocalPlayer = true;
        this._initialized = true;
    }

    _findLocalPlayerEntity() {
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            var tags = p.tags;
            var isRemote = false;
            if (tags) {
                if (typeof tags.has === "function") isRemote = tags.has("remote");
                else if (tags.indexOf) isRemote = tags.indexOf("remote") >= 0;
            }
            if (isRemote) continue;
            return p;
        }
        return null;
    }

    _refreshUsernamesFromRoster() {
        var mp = this.scene._mp;
        if (!mp || !mp.roster) return;
        var peers = mp.roster.peers || [];
        this._knownUsernames = {};
        for (var i = 0; i < peers.length; i++) {
            this._knownUsernames[peers[i].peerId] = peers[i].username;
        }
    }

    _updateLabels() {
        if (!this.ui || !this.ui.createText || !this.scene.worldToScreen) return;
        var active = {};
        var players = this.scene.findEntitiesByTag ? this.scene.findEntitiesByTag("player") : [];
        for (var i = 0; i < players.length; i++) {
            var p = players[i];
            if (!p.active) continue;
            var ni = p.getComponent("NetworkIdentityComponent");
            if (!ni) continue;
            // Don't label our own player — the local view is first/third-
            // person on yourself, and a tag hovering over your own head
            // is just visual noise.
            if (ni.isLocalPlayer) continue;
            var peerId = (ni.ownerId && typeof ni.ownerId === "string") ? ni.ownerId : "";
            if (!peerId) continue;
            var username = this._knownUsernames[peerId] || peerId.slice(0, 6);
            active[p.id] = true;

            var entry = this._labels[p.id];
            if (!entry) {
                entry = {
                    el: this.ui.createText({
                        text: username,
                        fontSize: 13,
                        color: "#ffffff",
                        backgroundColor: "rgba(0,0,0,0.65)",
                        padding: 4,
                        borderRadius: 4,
                        x: -999,
                        y: -999,
                    }),
                    username: username,
                };
                this._labels[p.id] = entry;
            } else if (entry.username !== username) {
                entry.el.text = username;
                entry.username = username;
            }

            // Position above the character's head. Casual_Male.glb is
            // scaled 0.4 → roughly 0.8m tall, so a 1.2-unit y-offset
            // clears the hair and sits naturally in the air above them.
            var wp = p.getWorldPosition ? p.getWorldPosition() : p.transform.position;
            var sp = this.scene.worldToScreen(wp.x, wp.y + 1.2, wp.z);
            if (sp) {
                entry.el.x = Math.floor(sp.x);
                entry.el.y = Math.floor(sp.y);
            } else {
                entry.el.x = -999;
                entry.el.y = -999;
            }
        }

        // Remove labels for entities that left the scene.
        for (var id in this._labels) {
            if (!active[id]) {
                var dead = this._labels[id];
                if (dead.el && dead.el.destroy) dead.el.destroy();
                else if (dead.el && dead.el.remove) dead.el.remove();
                delete this._labels[id];
            }
        }
    }

    _hashPeerId(peerId) {
        var h = 2166136261;
        for (var i = 0; i < peerId.length; i++) {
            h ^= peerId.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return ((h >>> 0) % 1000000) + 1000;
    }

    onDestroy() {
        for (var id in this._labels) {
            var dead = this._labels[id];
            if (dead.el && dead.el.destroy) dead.el.destroy();
            else if (dead.el && dead.el.remove) dead.el.remove();
        }
        this._labels = {};
    }
}
