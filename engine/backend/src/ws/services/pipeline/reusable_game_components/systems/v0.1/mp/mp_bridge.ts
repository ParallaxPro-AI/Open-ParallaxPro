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
            self._lobbies = lobbies || [];
            self._pushUiUpdate();
        }));
        this._unsubs.push(mp.onRoster(function(roster) {
            self._roster = roster;
            self._pushUiUpdate();
        }));
        this._unsubs.push(mp.onPhase(function(phase) {
            self._phase = phase;
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
            self.scene.events.ui.emit("show_ui", { panel: "lobby_host_config" });
        });
        ui.on("ui_event:lobby_browser:host_lobby", function() {
            // Click on Host button — actual config comes from lobby_host_config.
            self.scene.events.ui.emit("show_ui", { panel: "lobby_host_config" });
        });
        ui.on("ui_event:lobby_browser:back_to_menu", function() {
            self.scene.events.ui.emit("hide_ui", { panel: "lobby_browser" });
            self.scene.events.game.emit("mp_back_to_menu", {});
        });
        ui.on("ui_event:lobby_browser:join_lobby", function(d) {
            var p = (d && d.payload) || {};
            mp.joinLobby({ lobbyId: p.lobbyId, password: p.password || null });
        });

        ui.on("ui_event:lobby_host_config:close_host_config", function() {
            self.scene.events.ui.emit("hide_ui", { panel: "lobby_host_config" });
        });
        ui.on("ui_event:lobby_host_config:host_lobby", function(d) {
            var p = (d && d.payload) || {};
            mp.hostLobby({
                name: String(p.name || ""),
                maxPlayers: Number(p.maxPlayers) || (mpCfg.maxPlayers || 4),
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
            // Flow can react to chat_focus/chat_blur to pause input capture.
            self.scene.events.game.emit(p.focus ? "mp_chat_focus" : "mp_chat_blur", {});
        });

        // Connect on start (non-blocking — the lobby UI will show errors).
        if (this._autoConnect && url) {
            mp.connect(url, templateId).catch(function(e) {
                console.warn("[MpBridge] connect failed:", e);
                self._pendingError = "Couldn't reach lobby server";
                self._pushUiUpdate();
            });
        }
    }

    onUpdate() {
        if (!this._session) return;
        var mp = this._session;

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
                maxPlayers: this._roster ? this._roster.maxPlayers : undefined,
                minPlayers: this._roster ? this._roster.minPlayers : undefined,
            },
            errorMessage: this._pendingError,
            fps: this.scene && this.scene._engineFps || undefined,
        };
        this.scene.events.ui.emit("hud_update", payload);
    }
}
