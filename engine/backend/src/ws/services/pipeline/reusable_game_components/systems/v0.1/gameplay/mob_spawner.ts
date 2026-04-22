// also: enemy waves, night spawning, enemy management, cave creatures, AI hostile units
// Mob spawner — spawns hostile mobs at night and underground
class MobSpawnerSystem extends GameScript {
    _maxSurfaceMobs = 8;
    _maxCaveMobs = 6;
    _nightSpawnRate = 10;
    _caveSpawnRate = 25;
    _spawnDistance = 25;
    _despawnDistance = 50;
    _nightMobs = [];
    _caveMobs = [];

    _spawnTimer = 0;
    _spawnedMobs = [];
    _gameActive = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("game_ready", function() {
            self._gameActive = true;
            self._spawnedMobs = [];
            self._spawnTimer = 5;
        });
        this.scene.events.game.on("nightfall", function() {
            self._spawnTimer = 3;
        });
        this.scene.events.game.on("entity_killed", function(data) {
            for (var i = self._spawnedMobs.length - 1; i >= 0; i--) {
                if (self._spawnedMobs[i] && self._spawnedMobs[i].id === data.entityId) {
                    self._spawnedMobs.splice(i, 1);
                    break;
                }
            }
        });
    }

    onUpdate(dt) {
        if (!this._gameActive) return;

        var player = this.scene.findEntityByName("Player");
        if (!player) return;
        var pp = player.transform.position;

        // Despawn far mobs
        for (var i = this._spawnedMobs.length - 1; i >= 0; i--) {
            var mob = this._spawnedMobs[i];
            if (!mob || !mob.active) { this._spawnedMobs.splice(i, 1); continue; }
            var mp = mob.transform.position;
            var dist = Math.sqrt((mp.x - pp.x) * (mp.x - pp.x) + (mp.z - pp.z) * (mp.z - pp.z));
            if (dist > this._despawnDistance) {
                mob.active = false;
                this._spawnedMobs.splice(i, 1);
            }
        }

        // Spawn timer
        this._spawnTimer -= dt;
        if (this._spawnTimer > 0) return;

        // Only spawn at night (check scene state from day_night_cycle)
        var isNight = this.scene._isNight || false;

        // Update night flag from HUD state
        // The day_night_cycle emits nightfall/daybreak events which we listen to

        if (this._spawnedMobs.length < this._maxSurfaceMobs) {
            this._spawnTimer = this._nightSpawnRate;
            if (this._nightMobs.length === 0) return;
            var mobType = this._nightMobs[Math.floor(Math.random() * this._nightMobs.length)];
            var angle = Math.random() * Math.PI * 2;
            var dist = this._spawnDistance + Math.random() * 10;
            var sx = pp.x + Math.cos(angle) * dist;
            var sz = pp.z + Math.sin(angle) * dist;

            var mob = this.scene.spawnEntity(mobType);
            if (mob) {
                this.scene.setPosition(mob.id, sx, 1, sz);
                if (mob.playAnimation) mob.playAnimation("Idle", { loop: true });
                this._spawnedMobs.push(mob);
            }
        }
    }
}
