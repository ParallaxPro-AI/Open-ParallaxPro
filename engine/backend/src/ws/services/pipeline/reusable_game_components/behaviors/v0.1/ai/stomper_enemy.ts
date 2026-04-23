// also: classic_platformer, jump_enemy, arcade_foe, side_scroller, smb_style
// Stomper enemy — 2.5D side-scrolling foe that walks back and forth on
// a fixed Y, can be stomped from above (kills it + bounces the player),
// and damages the player on side contact.
//
// Reusable in any 2.5D arcade platformer that wants SMB-style enemies.
// The actual stomp/hit resolution lives in the level engine — this
// behavior just walks, faces direction, and exposes "alive + position +
// kind" through the entity's tags so the engine can scan for it.
//
// Death is signalled by entity_killed; the engine handles scoring
// + visual cleanup. We just shrink the mesh to nothing on hit so the
// entity reference stays valid while the engine processes.
class StomperEnemyBehavior extends GameScript {
    _behaviorName = "stomper_enemy";
    _moveSpeed = 1.6;
    _patrolRange = 4;
    _constrainZ = 0;
    _groundY = 1.4;
    _stompTopMargin = 0.6;
    _deathSound = "";

    _alive = true;
    _dir = 1;
    _startX = 0;
    _currentAnim = "";
    _stompTimer = 0;

    onStart() {
        var self = this;
        var pos = this.entity.transform.position;
        this._startX = pos.x;
        this._dir = Math.random() < 0.5 ? 1 : -1;
        this._alive = true;
        this._registerSelf();

        this.scene.events.game.on("entity_killed", function(d) {
            if (!d || d.entityId !== self.entity.id) return;
            self._die();
        });
        this.scene.events.game.on("game_ready", function() { self._reset(); });
        this.scene.events.game.on("restart_game", function() { self._reset(); });
    }

    onUpdate(dt) {
        if (!this.entity || !this.entity.transform) return;
        if (!this._alive) {
            // After death — let the squash play out for a beat then
            // mark inactive so the engine's scan skips us.
            if (this._stompTimer > 0) this._stompTimer -= dt;
            return;
        }

        var pos = this.entity.transform.position;
        var newX = pos.x + this._dir * this._moveSpeed * dt;
        if (Math.abs(newX - this._startX) > this._patrolRange) {
            this._dir *= -1;
            newX = pos.x + this._dir * this._moveSpeed * dt;
        }
        this.scene.setPosition(this.entity.id, newX, this._groundY, this._constrainZ);
        this.entity.transform.setRotationEuler && this.entity.transform.setRotationEuler(0, this._dir > 0 ? -90 : 90, 0);
        this.entity.transform.markDirty && this.entity.transform.markDirty();
        this._registerSelf();
        this._playAnim("Walk");
    }

    _die() {
        if (!this._alive) return;
        this._alive = false;
        this._stompTimer = 0.25;
        if (this.audio && this._deathSound) this.audio.playSound(this._deathSound, 0.32);
        // Squash visually — flatten to a thin disc for a brief beat, then
        // scale to zero. Looks like the SMB squish.
        this.scene.setScale && this.scene.setScale(this.entity.id, 1.6, 0.3, 1.6);
        var self = this;
        setTimeout(function() {
            self.scene.setScale && self.scene.setScale(self.entity.id, 0, 0, 0);
            if (self.entity) self.entity.active = false;
        }, 250);
    }

    _reset() {
        this._alive = true;
        this._stompTimer = 0;
        this.scene.setScale && this.scene.setScale(this.entity.id, 1.6, 1.6, 1.6);
        this.scene.setPosition(this.entity.id, this._startX, this._groundY, this._constrainZ);
        if (this.entity) this.entity.active = true;
        this._registerSelf();
    }

    _registerSelf() {
        if (!this.scene._runnerEnemies) this.scene._runnerEnemies = {};
        this.scene._runnerEnemies[this.entity.id] = {
            alive: !!this._alive,
            x: this.entity.transform.position.x,
            y: this.entity.transform.position.y,
            stompTopMargin: this._stompTopMargin,
        };
    }

    _playAnim(name) {
        if (this._currentAnim === name) return;
        this._currentAnim = name;
        if (this.entity && this.entity.playAnimation) {
            try { this.entity.playAnimation(name, { loop: true }); } catch (e) { /* missing clip */ }
        }
    }
}
