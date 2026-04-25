// also: enemy-ai, chase, pursuit, horde, melee-ai, personal-space, flocking
// Chases the player while keeping personal space from other same-tag
// enemies — prevents the classic "horde towers up on the player's feet"
// bug in games with multiple melee enemies (warehouse shooters, zombie
// survival, tower defense with creep paths). Rapier resolves overlapping
// capsules by stacking vertically, so many dynamic bodies all converging
// on the same point (the player) pile into a column of arms + heads at
// eye height — that's what "I only see the enemies' arms" usually is.
//
// How the separation works:
//   Each frame, sum a repulsion vector from any same-tag neighbor within
//   `separationRadius`. Add that to the chase vector with a weight the
//   author can tune. Default weight (0.8) makes enemies flank + fan out
//   rather than cluster; set higher to emphasize spread, lower to prefer
//   attack range.
//
// Parameters:
//   tag                — which tag identifies "same kind" (default "enemy")
//   playerName         — entity name to chase (default "Player")
//   moveSpeed          — m/s when far from player (default 3.5)
//   attackRange        — stop moving inside this radius (default 1.6)
//   detectionRange     — beyond this distance, idle (default 30)
//   separationRadius   — only push away from neighbors closer than this (default 2.0)
//   separationWeight   — how strongly separation overrides chase (0..1, default 0.8)
class EnemyChaseWithSeparation extends GameScript {
    _behaviorName = "enemy_chase_with_separation";

    tag = "enemy";
    playerName = "Player";
    moveSpeed = 3.5;
    attackRange = 1.6;
    detectionRange = 30;
    separationRadius = 2.0;
    separationWeight = 0.8;

    _dead = false;

    onUpdate(dt) {
        if (this._dead) return;

        var player = this.scene.findEntityByName(this.playerName);
        if (!player || !player.active) {
            try { this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 }); } catch (e) {}
            return;
        }

        var pos = this.entity.transform.position;
        var pp = player.transform.position;
        var dx = pp.x - pos.x;
        var dz = pp.z - pos.z;
        var dist = Math.sqrt(dx * dx + dz * dz);

        if (dist > this.detectionRange || dist < 0.0001) {
            try { this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 }); } catch (e) {}
            return;
        }

        // Face the player (model faces -Z at yaw 0 in the engine's canonical frame).
        var yawDeg = Math.atan2(-dx, -dz) * 180 / Math.PI;
        this.entity.transform.setRotationEuler(0, yawDeg, 0);

        if (dist <= this.attackRange) {
            try { this.scene.setVelocity(this.entity.id, { x: 0, y: 0, z: 0 }); } catch (e) {}
            return;
        }

        // Chase direction (normalized).
        var nx = dx / dist;
        var nz = dz / dist;

        // Separation — sum repulsion from nearby neighbors with the same tag.
        var sepX = 0, sepZ = 0;
        var neighbors = this.scene.findEntitiesByTag ? (this.scene.findEntitiesByTag(this.tag) || []) : [];
        var r2 = this.separationRadius * this.separationRadius;
        for (var i = 0; i < neighbors.length; i++) {
            var n = neighbors[i];
            if (!n || n.id === this.entity.id) continue;
            var np = n.transform.position;
            var rdx = pos.x - np.x, rdz = pos.z - np.z;
            var rdistSq = rdx * rdx + rdz * rdz;
            if (rdistSq < r2 && rdistSq > 0.0001) {
                var rdist = Math.sqrt(rdistSq);
                // Closer neighbors push harder: 1 at touching, 0 at edge.
                var push = (this.separationRadius - rdist) / this.separationRadius;
                sepX += (rdx / rdist) * push;
                sepZ += (rdz / rdist) * push;
            }
        }

        // Blend chase + separation. moveSpeed scales the combined direction.
        var mx = nx + sepX * this.separationWeight;
        var mz = nz + sepZ * this.separationWeight;
        // Re-normalize so total speed doesn't exceed moveSpeed.
        var mlen = Math.sqrt(mx * mx + mz * mz);
        if (mlen > 1) { mx /= mlen; mz /= mlen; }

        try {
            this.scene.setVelocity(this.entity.id, {
                x: mx * this.moveSpeed,
                y: 0,
                z: mz * this.moveSpeed,
            });
        } catch (e) {}
    }
}
