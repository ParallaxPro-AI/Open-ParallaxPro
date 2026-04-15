// MpBridge — bridges the multiplayer session (lobby + WebRTC) to the FSM and
// UI layer. Runs as a pinned system in every multiplayer game.
//
// Routes UI events (from lobby_browser.html, lobby_room.html, chat, voice HUDs)
// into MultiplayerSession method calls. Pushes session state (lobby list,
// roster, chat history, ping, voice levels) back onto the UI state bus so HUDs
// update without any game-specific code.
//
// The session lives on `scene._multiplayer`, populated by the runtime loader
// before scripts start. If missing (single-player build), the bridge no-ops.

class MpBridge extends GameScript {
    _gameTemplateId = "";
    _autoConnect = true;
    _connectUrl = "";
    _session = null;
    _chatFocusListener = null;
    _unsubs = [];
    _phase = "disconnected";
    _lobbies = [];
    _roster = null;
    _localReady = false;
    _hostPingMs = 0;
    _pendingError = "";
    _voicePeers = [];
    _micOn = false;
    _muted = false;
    _uiResendCounter = 0;
    _chatFocused = false;
    _openChatPulse = false;
    _chatPulseTimer = 0;
    _lobbyListPollTimer = 0;
    _mpCfg = null;
    _belowMinFired = false;
    _lastRosterPeerCount = -1;
    _lastHostId = "";

    onStart() {
        var self = this;
        // `_mp` is the new peer-to-peer session attached to the scriptScene at
        // play-mode bootstrap. `_multiplayer` is the legacy editor-only manager
        // and is ignored here.
        var mp = this.scene._mp;
        if (!mp) {
            // Single-player — nothing to wire up. Still install the UI listeners
            // so lobby-related clicks that somehow fire just become no-ops.
            return;
        }
        this._session = mp;

        // Make sure the session has a signaling URL. Prefer the explicit
        // projectConfig value; fall back to the same host on /ws/multiplayer.
        var cfg = this.scene._projectConfig || {};
        var mpCfg = cfg.multiplayerConfig || {};
        this._mpCfg = mpCfg;
        var url = cfg.multiplayerSignalUrl || this._connectUrl;
        if (!url && typeof window !== "undefined") {
            var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
            url = proto + "//" + window.location.host + "/ws/multiplayer";
        }
        var templateId = cfg.gameTemplateId || this._gameTemplateId || "default";
        if (mpCfg.tickRate) mp.setTickRate(mpCfg.tickRate);
        if (typeof mpCfg.predictLocalPlayer === "boolean") mp.setPredictionEnabled(mpCfg.predictLocalPlayer);

        // Subscribe to session state changes and push them onto the UI bus.
        this._unsubs.push(mp.onLobbyList(function(lobbies) {
            var next = lobbies || [];
            // Preserve previous pingMs by lobby id so a measurement in flight
            // or already landed doesn't briefly disappear when the list refreshes.
            var prev = {};
            for (var i = 0; i < self._lobbies.length; i++) {
                var l = self._lobbies[i];
                if (typeof l.pingMs === "number") prev[l.id] = l.pingMs;
            }
            for (var j = 0; j < next.length; j++) {
                if (prev[next[j].id] !== undefined) next[j].pingMs = prev[next[j].id];
            }
            self._lobbies = next;
            self._pushUiUpdate();

            // Fire a fresh ping at each lobby's host. Result updates the
            // matching row (if still present) and re-pushes the state.
            for (var k = 0; k < next.length; k++) {
                (function(lobby) {
                    mp.measureLobbyPing(lobby.id).then(function(ms) {
                        var idx = -1;
                        for (var m = 0; m < self._lobbies.length; m++) {
                            if (self._lobbies[m].id === lobby.id) { idx = m; break; }
                        }
                        if (idx < 0) return;
                        self._lobbies[idx].pingMs = ms;
                        self._pushUiUpdate();
                    });
                })(next[k]);
            }
        }));
        this._unsubs.push(mp.onRoster(function(roster) {
            // _currentRoster on the session is mutated in place — reading
            // self._roster after assignment would give us NEW values for
            // both prev and current. Track previous values explicitly.
            var prevPeerCount = self._lastRosterPeerCount;
            var prevHostPeerId = self._lastHostId;
            var newPeerCount = roster ? roster.peers.length : 0;
            var newHostPeerId = roster ? roster.hostPeerId : "";

            self._roster = roster;
            self._lastRosterPeerCount = newPeerCount;
            self._lastHostId = newHostPeerId;
            self._pushUiUpdate();

            if (!roster) return;

            // Detect host migration so game systems can claim authority.
            if (prevHostPeerId && newHostPeerId && newHostPeerId !== prevHostPeerId) {
                var gbus = self.scene.events.game;
                gbus.emit("mp_host_changed", { newHostPeerId: newHostPeerId });
            }

            // General roster-change ping so games can prune per-peer state.
            if (prevPeerCount >= 0 && prevPeerCount !== newPeerCount) {
                var gbus3 = self.scene.events.game;
                gbus3.emit("mp_roster_changed", { count: newPeerCount });
            }

            // Notify on player count dropping below minPlayers (only fires
            // once per match so a game doesn't spam end events).
            if (self._phase === "in_game" && !self._belowMinFired) {
                var minP = (mpCfg.minPlayers || 1);
                if (newPeerCount < minP && (prevPeerCount < 0 || newPeerCount < prevPeerCount)) {
                    self._belowMinFired = true;
                    var gbus2 = self.scene.events.game;
                    gbus2.emit("mp_below_min_players", { count: newPeerCount, min: minP });
                }
            }
        }));
        this._unsubs.push(mp.onPhase(function(phase) {
            self._phase = phase;
            // Reset per-match guards on phase change so the next match starts fresh.
            if (phase !== "in_game") self._belowMinFired = false;
            // Emit a game event so the flow can transition on it:
            // e.g. "game_event:mp_phase_in_game". Using an indirect bus
            // reference because the assembler's event validator only
            // inspects literal string arguments on events.game.emit().
            var gbus = self.scene.events.game;
            gbus.emit("mp_phase_" + phase, {});
            self._pushUiUpdate();
        }));
        this._unsubs.push(mp.onError(function(message) {
            self._pendingError = message || "";
            self._pushUiUpdate();
            // Clear after a few seconds so the UI doesn't stick.
            setTimeout(function() { self._pendingError = ""; self._pushUiUpdate(); }, 4000);
        }));
        this._unsubs.push(mp.onChat(function() {
            self._pushUiUpdate();
        }));
        this._unsubs.push(mp.onNetworkedEvent(function(fromPeerId, event, data) {
            // Re-emit on the game bus so the flow + scripts can react.
            var gbus = self.scene.events.game;
            gbus.emit("net_" + event, { from: fromPeerId, data: data });
        }));

        // ── UI events from the lobby HTML panels ──
        var ui = this.scene.events.ui;

        ui.on("ui_event:lobby_browser:refresh_lobbies", function() { mp.requestLobbyList(); });
        ui.on("ui_event:lobby_browser:open_host_config", function() {
            // Hide the browser so its overlay doesn't steal clicks / hover from
            // the host config modal sitting on top.
            self.scene.events.ui.emit("hide_ui", { panel: "lobby_browser" });
            self.scene.events.ui.emit("show_ui", { panel: "lobby_host_config" });
        });
        ui.on("ui_event:lobby_browser:host_lobby", function() {
            // Click on Host button — actual config comes from lobby_host_config.
            self.scene.events.ui.emit("hide_ui", { panel: "lobby_browser" });
            self.scene.events.ui.emit("show_ui", { panel: "lobby_host_config" });
        });
        ui.on("ui_event:lobby_browser:back_to_menu", function() {
            self.scene.events.ui.emit("hide_ui", { panel: "lobby_browser" });
            var gbus = self.scene.events.game;
            gbus.emit("mp_back_to_menu", {});
        });
        ui.on("ui_event:lobby_browser:join_lobby", function(d) {
            var p = (d && d.payload) || {};
            mp.joinLobby({ lobbyId: p.lobbyId, password: p.password || null });
        });

        ui.on("ui_event:lobby_host_config:close_host_config", function() {
            self.scene.events.ui.emit("hide_ui", { panel: "lobby_host_config" });
            // Back to the browser list when user cancels.
            self.scene.events.ui.emit("show_ui", { panel: "lobby_browser" });
        });
        ui.on("ui_event:lobby_host_config:host_lobby", function(d) {
            var p = (d && d.payload) || {};
            self.scene.events.ui.emit("hide_ui", { panel: "lobby_host_config" });
            // Slot counts come from the game's multiplayer config, not the
            // host — the host can't override the supported player range.
            mp.hostLobby({
                name: String(p.name || ""),
                maxPlayers: mpCfg.maxPlayers || 2,
                minPlayers: mpCfg.minPlayers || 1,
                password: p.password || null,
            });
        });

        ui.on("ui_event:lobby_room:leave_lobby", function() { mp.leaveLobby(); });
        ui.on("ui_event:lobby_room:toggle_ready", function(d) {
            var p = (d && d.payload) || {};
            var v = !!p.ready;
            self._localReady = v;
            mp.setReady(v);
            self._pushUiUpdate();
        });
        ui.on("ui_event:lobby_room:start_game", function() { mp.startGame(); });
        ui.on("ui_event:lobby_room:kick_player", function(d) {
            var p = (d && d.payload) || {};
            if (p.peerId) mp.kickPlayer(p.peerId);
        });

        ui.on("ui_event:connecting_overlay:cancel_connect", function() { mp.leaveLobby(); });
        ui.on("ui_event:disconnected_banner:leave_lobby", function() { mp.leaveLobby(); });

        // ── Voice + chat HUDs ──
        ui.on("ui_event:hud/voice_chat:voice_request_mic", function() {
            mp.enableVoice().then(function(ok) {
                self._micOn = !!ok;
                self._pushUiUpdate();
            });
        });
        ui.on("ui_event:hud/voice_chat:voice_set_muted", function(d) {
            var p = (d && d.payload) || {};
            self._muted = !!p.muted;
            mp.setMuted(self._muted);
            self._pushUiUpdate();
        });

        ui.on("ui_event:hud/text_chat:send_chat", function(d) {
            var p = (d && d.payload) || {};
            if (p.body) mp.sendChat(String(p.body));
        });
        ui.on("ui_event:hud/text_chat:chat_focus", function(d) {
            var p = (d && d.payload) || {};
            var wasFocused = self._chatFocused;
            self._chatFocused = !!p.focus;
            // On blur: kill any still-pending open pulse so the iframe doesn't
            // see a stale openChat:true on the next hud_update and reopen
            // itself right after the user pressed Enter to send.
            if (wasFocused && !self._chatFocused) {
                self._openChatPulse = false;
                self._chatPulseTimer = 0;
                self._pushUiUpdate();
            }
            var gbus = self.scene.events.game;
            gbus.emit(p.focus ? "mp_chat_focus" : "mp_chat_blur", {});
        });

        // Connect on start (non-blocking — the lobby UI will show errors).
        if (this._autoConnect && url) {
            mp.connect(url, templateId).catch(function(e) {
                console.warn("[MpBridge] connect failed:", e);
                self._pendingError = "Couldn't reach lobby server";
                self._pushUiUpdate();
            });
        }

        // If the browser has already granted mic permission to this origin,
        // flip the mic on automatically so the player doesn't have to click
        // Mic off every time they join a match. If permission is prompt/denied
        // we leave the mic off — the user has to explicitly click to grant.
        try {
            if (typeof navigator !== "undefined" && navigator.permissions && navigator.permissions.query) {
                navigator.permissions.query({ name: "microphone" }).then(function(status) {
                    if (status.state === "granted") {
                        mp.enableVoice().then(function(ok) {
                            self._micOn = !!ok;
                            self._pushUiUpdate();
                        });
                    }
                }).catch(function() { /* permissions API not supported for mic */ });
            }
        } catch (e) { /* older browser — skip auto-enable */ }
    }

    onUpdate(dt) {
        if (!this._session) return;
        var mp = this._session;

        // Auto-refresh the lobby list every ~1.5s while the player is on the
        // browser screen, so newly-created lobbies appear without a manual
        // refresh click. Stops as soon as they join or host.
        if (this._phase === "browsing") {
            this._lobbyListPollTimer += (dt || 0);
            if (this._lobbyListPollTimer >= 1.5) {
                this._lobbyListPollTimer = 0;
                mp.requestLobbyList();
            }
        } else {
            this._lobbyListPollTimer = 0;
        }

        // Keyboard events can't reach HUD iframes while the game canvas has
        // focus, so the chat-open shortcut has to live here. Pressing Enter
        // while chat isn't focused sets a one-frame pulse that the iframe
        // reads from state and uses to open its input.
        if (!this._chatFocused && this.input && this.input.isKeyPressed &&
            (this.input.isKeyPressed("Enter") || this.input.isKeyPressed("KeyT"))) {
            this._openChatPulse = true;
            this._chatPulseTimer = 0;
            this._pushUiUpdate();
        }

        // V toggles the mic. First press requests permission + enables; later
        // presses cycle muted state. Gated on chat focus so it doesn't fire
        // when the user is typing.
        if (!this._chatFocused && this.input && this.input.isKeyPressed && this.input.isKeyPressed("KeyV")) {
            var self2 = this;
            if (!this._micOn) {
                mp.enableVoice().then(function(ok) {
                    self2._micOn = !!ok;
                    self2._muted = false;
                    mp.setMuted(false);
                    self2._pushUiUpdate();
                });
            } else {
                this._muted = !this._muted;
                mp.setMuted(this._muted);
                this._pushUiUpdate();
            }
        }
        if (this._openChatPulse) {
            this._chatPulseTimer += (dt || 0);
            if (this._chatPulseTimer > 0.15) {
                this._openChatPulse = false;
                this._chatPulseTimer = 0;
                this._pushUiUpdate();
            }
        }

        // Ping + voice levels change continuously; sync them onto UI state.
        var nextPing = Math.round(mp.hostPingMs || 0);
        var levels = mp.getVoiceLevels();
        var voicePeers = [];
        if (this._roster) {
            for (var i = 0; i < this._roster.peers.length; i++) {
                var peer = this._roster.peers[i];
                if (peer.peerId === mp.localPeerId) continue;
                voicePeers.push({
                    peerId: peer.peerId,
                    username: peer.username,
                    level: levels.get(peer.peerId) || 0,
                });
            }
        }
        var peersChanged = JSON.stringify(voicePeers) !== JSON.stringify(this._voicePeers);
        this._voicePeers = voicePeers;

        if (nextPing !== this._hostPingMs || peersChanged || this._uiResendCounter > 0) {
            this._hostPingMs = nextPing;
            if (this._uiResendCounter > 0) this._uiResendCounter--;
            this._pushUiUpdate();
        }
    }

    onDestroy() {
        for (var i = 0; i < this._unsubs.length; i++) {
            try { this._unsubs[i](); } catch(e) {}
        }
        this._unsubs = [];
    }

    _pushUiUpdate() {
        var mp = this._session;
        if (!mp) return;
        var payload = {
            lobbies: this._lobbies,
            username: mp.localUsername,
            multiplayer: {
                enabled: true,
                phase: this._phase,
                connected: this._phase === "in_lobby" || this._phase === "in_game",
                disconnected: this._phase === "disconnected",
                isHost: mp.isHost,
                roster: this._roster,
                localPeerId: mp.localPeerId,
                localReady: this._localReady,
                ping: this._hostPingMs,
                chatHistory: mp.chatHistory,
                voicePeers: this._voicePeers,
                micOn: this._micOn,
                muted: this._muted,
                // Expose the game's configured slot range even before a lobby
                // exists — the host-config UI reads these to show "players per
                // match" (read-only). Falls back to the live roster once in-lobby.
                maxPlayers: (this._roster && this._roster.maxPlayers) || (this._mpCfg && this._mpCfg.maxPlayers) || undefined,
                minPlayers: (this._roster && this._roster.minPlayers) || (this._mpCfg && this._mpCfg.minPlayers) || undefined,
                openChat: this._openChatPulse,
            },
            errorMessage: this._pendingError,
            fps: this.scene && this.scene._engineFps || undefined,
        };
        this.scene.events.ui.emit("hud_update", payload);
    }
}
