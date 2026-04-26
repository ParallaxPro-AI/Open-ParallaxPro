// also: sport, football, team, goal, possession
// Soccer match — ball physics, AI players, scoring, match timer, kickoff
class SoccerMatchSystem extends GameScript {
    _matchDuration = 180;
    _kickPower = 22;
    _passPower = 15;
    _aiSpeed = 6;
    _gkSpeed = 5;
    _friction = 0.985;
    _dribbleRange = 1.8;
    _kickRange = 2.0;

    _ballVx = 0;
    _ballVz = 0;
    _ballEntity = null;
    _scoreA = 0;
    _scoreB = 0;
    _timer = 180;
    _matchActive = false;
    _matchOver = false;
    _kickCooldown = 0;
    _aiList = [];
    _aiInited = false;

    onStart() {
        var self = this;

        this.scene.events.game.on("game_ready", function() {
            self._fullReset();
        });

        this.scene.events.game.on("race_started", function() {
            // Snap ball + every player back to their kickoff spot before
            // the whistle. Covers the initial kickoff and the post-goal
            // restart (flow re-fires race_started after the celebration
            // → kickoff substates). Without this, the ball respawned at
            // centre but players stayed wherever the goal scramble left
            // them, so kickoff was never actually a kickoff.
            self._resetPositions();
            self._matchActive = true;
        });

        this.scene.events.game.on("score_changed", function() {
            self._matchActive = false;
        });
    }

    _fullReset() {
        this._scoreA = 0;
        this._scoreB = 0;
        this._timer = this._matchDuration;
        this._matchOver = false;
        this._matchActive = false;
        this._ballVx = 0;
        this._ballVz = 0;
        this._updateHud();
    }

    _resetPositions() {
        this._ballVx = 0;
        this._ballVz = 0;

        var ball = this._getBall();
        if (ball) this.scene.setPosition(ball.id, 0, 0.3, 0);

        var positions = {
            "Player": [-5, 0],
            "A_Forward": [-8, 12],
            "A_Mid_1": [-22, -10],
            "A_Mid_2": [-22, 10],
            "A_GK": [-46, 0],
            "B_Forward_1": [8, -5],
            "B_Forward_2": [8, 8],
            "B_Mid_1": [22, -10],
            "B_Mid_2": [22, 10],
            "B_GK": [46, 0]
        };

        for (var name in positions) {
            var ent = this.scene.findEntityByName(name);
            if (ent) {
                var p = positions[name];
                this.scene.setPosition(ent.id, p[0], 0, p[1]);
                this.scene.setVelocity(ent.id, { x: 0, y: 0, z: 0 });
            }
        }

        this._updateHud();
    }

    _getBall() {
        if (this._ballEntity) return this._ballEntity;
        var balls = this.scene.findEntitiesByTag("ball");
        if (balls && balls.length > 0) {
            this._ballEntity = balls[0];
            return this._ballEntity;
        }
        return null;
    }

    _initAI() {
        this._aiInited = true;
        this._aiList = [];
        var aiEntities = this.scene.findEntitiesByTag("soccer_ai") || [];
        for (var i = 0; i < aiEntities.length; i++) {
            var e = aiEntities[i];
            var tags = e.tags || [];
            var team = "b", role = "midfielder";
            for (var t = 0; t < tags.length; t++) {
                if (tags[t] === "team_a") team = "a";
                if (tags[t] === "team_b") team = "b";
                if (tags[t] === "forward") role = "forward";
                if (tags[t] === "midfielder") role = "midfielder";
                if (tags[t] === "goalkeeper") role = "goalkeeper";
            }
            var pos = e.transform.position;
            this._aiList.push({
                entity: e,
                team: team,
                role: role,
                homeX: pos.x,
                homeZ: pos.z,
                kickCd: Math.random() * 0.5,
                anim: ""
            });
        }
    }

    _dist2d(ax, az, bx, bz) {
        var dx = ax - bx, dz = az - bz;
        return Math.sqrt(dx * dx + dz * dz);
    }

    _updateHud() {
        var mins = Math.floor(this._timer / 60);
        var secs = Math.floor(this._timer % 60);
        var timeStr = mins + ":" + (secs < 10 ? "0" : "") + secs;
        this.scene.events.ui.emit("hud_update", {
            scoreA: this._scoreA,
            scoreB: this._scoreB,
            matchTime: timeStr
        });
    }

    _goalScored(team) {
        if (team === "a") {
            this._scoreA++;
        } else {
            this._scoreB++;
        }
        this._matchActive = false;
        this._updateHud();

        this.scene.events.ui.emit("hud_update", { goalFlash: true, goalTeam: team === "a" ? "HOME" : "AWAY" });
        if (this.audio) this.audio.playSound("/assets/kenney/audio/voiceover_pack/male/congratulations.ogg", 0.6);

        this.scene.events.game.emit("score_changed", { score: team === "a" ? this._scoreA : this._scoreB });
    }

    _playAiAnim(ai, name) {
        if (ai.anim === name) return;
        ai.anim = name;
        if (ai.entity.playAnimation) {
            ai.entity.playAnimation(name, { loop: true });
        }
    }

    onUpdate(dt) {
        if (!this._aiInited) this._initAI();
        if (!this._matchActive) return;

        var ball = this._getBall();
        if (!ball) return;
        var bp = ball.transform.position;

        // Timer
        this._timer -= dt;
        if (this._timer <= 0) {
            this._timer = 0;
            this._matchOver = true;
            this._matchActive = false;
            var title = this._scoreA > this._scoreB ? "YOU WIN!" : (this._scoreA < this._scoreB ? "YOU LOSE!" : "DRAW!");
            this.scene.events.ui.emit("hud_update", {
                _gameOver: {
                    title: title,
                    score: this._scoreA,
                    stats: { "Home": "" + this._scoreA, "Away": "" + this._scoreB }
                }
            });
            this.scene.events.game.emit("game_over", {});
            return;
        }
        this._updateHud();

        this._kickCooldown -= dt;

        // Ball physics
        bp.x += this._ballVx * dt;
        bp.z += this._ballVz * dt;
        this._ballVx *= this._friction;
        this._ballVz *= this._friction;
        if (Math.abs(this._ballVx) < 0.05) this._ballVx = 0;
        if (Math.abs(this._ballVz) < 0.05) this._ballVz = 0;

        // Side boundaries
        if (bp.z > 29) { bp.z = 29; this._ballVz = -Math.abs(this._ballVz) * 0.6; }
        if (bp.z < -29) { bp.z = -29; this._ballVz = Math.abs(this._ballVz) * 0.6; }

        // Goal check
        if (bp.x < -50 && Math.abs(bp.z) < 3.6) {
            this._goalScored("b");
            this.scene.setPosition(ball.id, 0, 0.3, 0);
            return;
        }
        if (bp.x > 50 && Math.abs(bp.z) < 3.6) {
            this._goalScored("a");
            this.scene.setPosition(ball.id, 0, 0.3, 0);
            return;
        }

        // End line out (not in goal) — reset ball
        if (bp.x < -52 || bp.x > 52) {
            this._ballVx = 0;
            this._ballVz = 0;
            bp.x = Math.max(-50, Math.min(50, bp.x));
        }

        this.scene.setPosition(ball.id, bp.x, 0.3, bp.z);

        // Player dribble and kick
        var player = this.scene.findEntityByName("Player");
        if (player) {
            var pp = player.transform.position;
            var pDist = this._dist2d(pp.x, pp.z, bp.x, bp.z);

            // Dribble
            var pvx = 0, pvz = 0;
            var prb = player.getComponent ? player.getComponent("RigidbodyComponent") : null;
            if (prb && prb.getLinearVelocity) {
                var pv = prb.getLinearVelocity();
                pvx = pv.x || 0;
                pvz = pv.z || 0;
            }
            var pMoving = Math.abs(pvx) > 0.5 || Math.abs(pvz) > 0.5;

            if (pDist < this._dribbleRange && pMoving) {
                var facing = this.scene._playerFacingRad || 0;
                var aheadX = pp.x + Math.sin(facing) * 1.2;
                var aheadZ = pp.z - Math.cos(facing) * 1.2;
                this._ballVx += (aheadX - bp.x) * 6 * dt;
                this._ballVz += (aheadZ - bp.z) * 6 * dt;
            }

            // Kick
            if (this.input.isKeyPressed("Space") && pDist < this._kickRange && this._kickCooldown <= 0) {
                var facing = this.scene._playerFacingRad || 0;
                var power = this.input.isKeyDown("ShiftLeft") ? this._kickPower * 1.3 : this._kickPower;
                this._ballVx = Math.sin(facing) * power;
                this._ballVz = -Math.cos(facing) * power;
                this._kickCooldown = 0.3;
                if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_medium_000.ogg", 0.5);
            }

            // Pass
            if (this.input.isKeyPressed("KeyE") && pDist < this._kickRange && this._kickCooldown <= 0) {
                var nearest = null, nearDist = 999;
                var teammates = this.scene.findEntitiesByTag("team_a") || [];
                for (var i = 0; i < teammates.length; i++) {
                    if (teammates[i].id === player.id) continue;
                    var tp = teammates[i].transform.position;
                    var d = this._dist2d(bp.x, bp.z, tp.x, tp.z);
                    if (d < nearDist) { nearDist = d; nearest = tp; }
                }
                if (nearest) {
                    var pdx = nearest.x - bp.x, pdz = nearest.z - bp.z;
                    var pdd = Math.sqrt(pdx * pdx + pdz * pdz);
                    if (pdd > 0) {
                        this._ballVx = (pdx / pdd) * this._passPower;
                        this._ballVz = (pdz / pdd) * this._passPower;
                    }
                    this._kickCooldown = 0.3;
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_medium_002.ogg", 0.4);
                }
            }
        }

        // AI movement and kicking
        for (var a = 0; a < this._aiList.length; a++) {
            var ai = this._aiList[a];
            if (!ai.entity.active) continue;
            ai.kickCd -= dt;

            var ap = ai.entity.transform.position;
            var aDist = this._dist2d(ap.x, ap.z, bp.x, bp.z);

            var targetGoalX = ai.team === "a" ? 50 : -50;
            var chaseRange = ai.role === "goalkeeper" ? 12 : (ai.role === "forward" ? 35 : 25);
            var speed = ai.role === "goalkeeper" ? this._gkSpeed : this._aiSpeed;
            var isMoving = false;

            // Zone check — should this AI chase?
            var inZone = true;
            if (ai.role === "goalkeeper") {
                inZone = aDist < 15;
            } else if (ai.role === "forward" && ai.team === "a") {
                inZone = bp.x > -30;
            } else if (ai.role === "forward" && ai.team === "b") {
                inZone = bp.x < 30;
            }

            if (inZone && aDist < chaseRange) {
                // Chase ball
                var cdx = bp.x - ap.x, cdz = bp.z - ap.z;
                var cd = Math.sqrt(cdx * cdx + cdz * cdz);
                if (cd > 0.5) {
                    var mx = ap.x + (cdx / cd) * speed * dt;
                    var mz = ap.z + (cdz / cd) * speed * dt;
                    mx = Math.max(-52, Math.min(52, mx));
                    mz = Math.max(-32, Math.min(32, mz));
                    this.scene.setPosition(ai.entity.id, mx, 0, mz);
                    ai.entity.transform.setRotationEuler(0, Math.atan2(-cdx, cdz) * 180 / Math.PI, 0);
                    isMoving = true;
                }

                // Kick if close
                if (aDist < this._kickRange && ai.kickCd <= 0) {
                    ai.kickCd = 0.8 + Math.random() * 0.5;
                    var kx = targetGoalX - bp.x;
                    var kz = 0 - bp.z;
                    var kd = Math.sqrt(kx * kx + kz * kz);
                    if (kd > 0) {
                        var aiPower = this._kickPower * (0.6 + Math.random() * 0.3);
                        this._ballVx = (kx / kd) * aiPower;
                        this._ballVz = (kz / kd) * aiPower + (Math.random() - 0.5) * 4;
                    }
                    if (this.audio) this.audio.playSound("/assets/kenney/audio/impact_sounds/impactSoft_medium_004.ogg", 0.3);
                }
            } else {
                // Drift toward home with ball influence
                var homeX = ai.homeX + bp.x * (ai.role === "goalkeeper" ? 0 : 0.2);
                var homeZ = ai.homeZ + bp.z * (ai.role === "goalkeeper" ? 0.3 : 0.15);
                homeX = Math.max(-52, Math.min(52, homeX));
                homeZ = Math.max(-32, Math.min(32, homeZ));
                var hx = homeX - ap.x, hz = homeZ - ap.z;
                var hd = Math.sqrt(hx * hx + hz * hz);
                if (hd > 1) {
                    var driftSpeed = speed * 0.4;
                    this.scene.setPosition(ai.entity.id,
                        ap.x + (hx / hd) * driftSpeed * dt,
                        0,
                        ap.z + (hz / hd) * driftSpeed * dt
                    );
                    ai.entity.transform.setRotationEuler(0, Math.atan2(-hx, hz) * 180 / Math.PI, 0);
                    isMoving = true;
                }
            }

            this._playAiAnim(ai, isMoving ? "Run" : "Idle");
        }
    }
}
