// also: paddle mechanics, serve system, rally mechanics, AI paddle control, classic arcade physics
// Pong engine — ball physics, collision, AI opponent, scoring
class PongEngineSystem extends GameScript {
    _winScore = 7;
    _ballSpeed = 8;
    _ballSpeedIncrease = 0.4;
    _aiSpeed = 7;
    _serveDelay = 90;

    _ballVx = 0;
    _ballVz = 0;
    _p1Score = 0;
    _p2Score = 0;
    _serving = true;
    _serveTimer = 0;
    _gameActive = false;
    _currentSpeed = 8;

    _paddleHitSound = "/assets/kenney/audio/impact_sounds/impactPlate_light_000.ogg";
    _wallBounceSound = "/assets/kenney/audio/impact_sounds/impactTin_medium_000.ogg";
    _scoreSound = "/assets/kenney/audio/interface_sounds/confirmation_002.ogg";
    _winSound = "/assets/kenney/audio/digital_audio/powerUp5.ogg";

    _ball = null;
    _paddleP1 = null;
    _paddleP2 = null;

    onStart() {
        var self = this;

        var balls = this.scene.findEntitiesByTag("ball");
        if (balls && balls.length > 0) self._ball = balls[0];

        var p1 = this.scene.findEntitiesByTag("player1");
        if (p1 && p1.length > 0) self._paddleP1 = p1[0];

        var p2 = this.scene.findEntitiesByTag("player2");
        if (p2 && p2.length > 0) self._paddleP2 = p2[0];

        this.scene.events.game.on("new_round", function() {
            self._resetGame();
        });

        this.scene.events.game.on("game_ready", function() {
            self._resetGame();
        });
    }

    _resetGame() {
        this._p1Score = 0;
        this._p2Score = 0;
        this._currentSpeed = this._ballSpeed;
        this._gameActive = true;
        this._updateHud();
        this._serve();
    }

    _serve() {
        this._serving = true;
        this._serveTimer = 0;
        this._ballVx = 0;
        this._ballVz = 0;
        if (this._ball) {
            this.scene.setPosition(this._ball.id, 0, 0.3, 0);
        }
    }

    _launchBall() {
        this._serving = false;
        var angle = (Math.random() * 0.8 - 0.4);
        var dir = Math.random() < 0.5 ? 1 : -1;
        this._ballVx = Math.cos(angle) * this._currentSpeed * dir;
        this._ballVz = Math.sin(angle) * this._currentSpeed;
    }

    _updateHud() {
        this.scene.events.ui.emit("hud_update", {
            p1Score: this._p1Score,
            p2Score: this._p2Score
        });
    }

    _scorePoint(player) {
        if (player === 1) {
            this._p1Score++;
        } else {
            this._p2Score++;
        }
        this._updateHud();
        if (this.audio) this.audio.playSound(this._scoreSound, 0.6);
        this.scene.events.game.emit("score_changed", { score: player === 1 ? this._p1Score : this._p2Score });

        if (this._p1Score >= this._winScore || this._p2Score >= this._winScore) {
            var winner = this._p1Score >= this._winScore ? "Player 1" : "Player 2";
            this.scene.events.ui.emit("hud_update", {
                _gameOver: {
                    title: winner + " Wins!",
                    score: Math.max(this._p1Score, this._p2Score),
                    stats: { "Player 1": this._p1Score, "Player 2": this._p2Score }
                }
            });
            this._gameActive = false;
            if (this.audio) this.audio.playSound(this._winSound, 0.7);
            this.scene.events.game.emit("game_over", {});
            return;
        }

        this._currentSpeed = this._ballSpeed;
        this._serve();
    }

    _handlePaddleHit(paddleZ, direction) {
        if (this.audio) this.audio.playSound(this._paddleHitSound, 0.5);
        var bPos = this._ball.transform.position;
        var relZ = (bPos.z - paddleZ) / 1.3;
        if (relZ > 1) relZ = 1;
        if (relZ < -1) relZ = -1;
        var angle = relZ * Math.PI / 3;
        this._currentSpeed = Math.min(this._currentSpeed + this._ballSpeedIncrease, 20);
        this._ballVx = Math.cos(angle) * this._currentSpeed * direction;
        this._ballVz = Math.sin(angle) * this._currentSpeed;
    }

    onUpdate(dt) {
        if (!this._gameActive || !this._ball) return;

        if (this._serving) {
            this._serveTimer++;
            if (this._serveTimer >= this._serveDelay) {
                this._launchBall();
            }
            return;
        }

        var bPos = this._ball.transform.position;
        var newX = bPos.x + this._ballVx * dt;
        var newZ = bPos.z + this._ballVz * dt;

        // Wall bounce
        var wallLimit = 6.7;
        if (newZ > wallLimit) {
            newZ = wallLimit;
            this._ballVz = -Math.abs(this._ballVz);
            if (this.audio) this.audio.playSound(this._wallBounceSound, 0.4);
        } else if (newZ < -wallLimit) {
            newZ = -wallLimit;
            this._ballVz = Math.abs(this._ballVz);
            if (this.audio) this.audio.playSound(this._wallBounceSound, 0.4);
        }

        // P1 paddle collision (left, X=-9)
        if (this._paddleP1 && this._ballVx < 0) {
            var p1Pos = this._paddleP1.transform.position;
            if (newX <= -8.5 && newX >= -9.5) {
                if (Math.abs(newZ - p1Pos.z) < 1.3) {
                    newX = -8.5;
                    this._handlePaddleHit(p1Pos.z, 1);
                }
            }
        }

        // P2 paddle collision (right, X=9)
        if (this._paddleP2 && this._ballVx > 0) {
            var p2Pos = this._paddleP2.transform.position;
            if (newX >= 8.5 && newX <= 9.5) {
                if (Math.abs(newZ - p2Pos.z) < 1.3) {
                    newX = 8.5;
                    this._handlePaddleHit(p2Pos.z, -1);
                }
            }
        }

        // Scoring
        if (newX < -11) {
            this._scorePoint(2);
            return;
        }
        if (newX > 11) {
            this._scorePoint(1);
            return;
        }

        this.scene.setPosition(this._ball.id, newX, 0.3, newZ);

        // AI for P2 paddle
        if (this._paddleP2) {
            var p2Pos2 = this._paddleP2.transform.position;
            var targetZ = 0;
            if (this._ballVx > 0) {
                targetZ = bPos.z;
            }
            var diff = targetZ - p2Pos2.z;
            var aiMove = 0;
            if (Math.abs(diff) > 0.3) {
                aiMove = diff > 0 ? 1 : -1;
            }
            var newP2Z = p2Pos2.z + aiMove * this._aiSpeed * dt;
            if (newP2Z > 5.5) newP2Z = 5.5;
            if (newP2Z < -5.5) newP2Z = -5.5;
            this.scene.setPosition(this._paddleP2.id, p2Pos2.x, p2Pos2.y, newP2Z);
        }
    }
}
