// also: wave spawn, AI attack, mob management, base assault, tower defense
// Enemy commander — AI that sends waves of enemies against the player base
class EnemyCommanderSystem extends GameScript {
    _waveInterval = 30; _waveSize = 3; _maxWaves = 5; _enemyTypes = [];
    _waveTimer = 0; _wave = 0; _gameActive = false;
    onStart() { var s = this; this.scene.events.game.on("game_ready", function() { s._waveTimer = 10; s._wave = 0; s._gameActive = true; }); }
    onUpdate(dt) { if (!this._gameActive) return;
        this._waveTimer -= dt;
        if (this._waveTimer <= 0 && this._wave < this._maxWaves) {
            this._wave++; this._waveTimer = this._waveInterval;
            this.scene.events.game.emit("wave_started", { wave: this._wave });
            if (this.audio) this.audio.playSound("/assets/kenney/audio/interface_sounds/error_006.ogg", 0.4);
            for (var i = 0; i < this._waveSize + this._wave; i++) {
                var type = this._enemyTypes.length > 0 ? this._enemyTypes[Math.floor(Math.random()*this._enemyTypes.length)] : "enemy_swarm";
                var ent = this.scene.spawnEntity(type);
                if (ent) { var angle = Math.random()*Math.PI*2; var dist = 35+Math.random()*10;
                    this.scene.setPosition(ent.id, Math.cos(angle)*dist, 1, Math.sin(angle)*dist);
                    if (ent.playAnimation) ent.playAnimation("Idle",{loop:true}); }
            }
        }
        this.scene.events.ui.emit("hud_update", {
            wave: this._wave, maxWaves: this._maxWaves,
            nextWave: Math.max(0, Math.ceil(this._waveTimer)),
            aiState: this._wave > 0 ? "war" : "peace"
        });
    }
}
