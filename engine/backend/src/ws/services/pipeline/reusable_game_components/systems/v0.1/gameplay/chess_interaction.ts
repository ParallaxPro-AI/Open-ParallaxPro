// also: input handling, piece selection, visual feedback, move validation UI
// Chess piece interaction system — virtual cursor click to select/move pieces with highlights
class ChessInteractionSystem extends GameScript {
    _selectedPiece = null;
    _pendingClick = null;
    _highlights = [];
    _validMoves = [];
    _highlight_y = 0.12;
    _selectedHighlightId = null;
    _myColor = "white";
    _mpBound = false;
    _isMultiplayer = false;
    _turnColor = "white";

    onStart() {
        var self = this;
        this.scene.events.ui.on("cursor_click", function(d) {
            if (self.entity.active !== false) self._pendingClick = d;
        });
        // Track turn changes — every moveMade toggles turn
        this.scene.events.game.on("move_made", function() {
            self._turnColor = (self._turnColor === "white") ? "black" : "white";
        });
        // Multiplayer: set which color this player controls
        var mp = this.scene._multiplayer;
        if (mp) {
            this._mpBound = true;
            this._isMultiplayer = true;
            this._myColor = mp.isRoomHost ? "white" : "black";
        }
    }

    _clearHighlights() {
        for (var i = 0; i < this._highlights.length; i++) {
            this.scene.destroyEntity(this._highlights[i]);
        }
        this._highlights = [];
        this._validMoves = [];
        this._selectedHighlightId = null;
    }

    _showHighlights(piece) {
        this._clearHighlights();
        var pos = piece.transform.position;
        var px = Math.round(pos.x);
        var pz = Math.round(pos.z);
        var name = piece.name.toLowerCase();
        var moves = this._getValidMoves(name, px, pz);
        this._validMoves = moves;

        // Show selection indicator under the selected piece
        try {
            var sel = this.scene.spawnEntity("selection");
            sel.transform.position = { x: px, y: this._highlight_y, z: pz };
            sel.transform.scale = { x: 0.9, y: 0.02, z: 0.9 };
            var selData = {};
            selData.meshType = "cube";
            selData.baseColor = [0.3, 0.6, 1.0, 1];
            this.scene.addComponent(sel.id, "MeshRendererComponent", selData);
            this._selectedHighlightId = sel.id;
            this._highlights.push(sel.id);
        } catch(e) {}

        for (var i = 0; i < moves.length; i++) {
            var m = moves[i];
            try {
                var ent = this.scene.spawnEntity("highlight");
                ent.transform.position = { x: m.x, y: this._highlight_y, z: m.z };
                ent.transform.scale = { x: 0.8, y: 0.02, z: 0.8 };
                var hlData = {};
                hlData.meshType = "cube";
                hlData.baseColor = [0.2, 0.9, 0.3, 1];
                this.scene.addComponent(ent.id, "MeshRendererComponent", hlData);
                this._highlights.push(ent.id);
            } catch(e) {}
        }
    }

    _isOccupiedByMe(x, z) {
        var pieces = this.scene.findEntitiesByTag(this._myColor) || [];
        for (var i = 0; i < pieces.length; i++) {
            var pp = pieces[i].transform.position;
            if (Math.round(pp.x) === x && Math.round(pp.z) === z) return true;
        }
        return false;
    }

    _isOccupied(x, z) {
        var pieces = this.scene.findEntitiesByTag("piece") || [];
        for (var i = 0; i < pieces.length; i++) {
            var pp = pieces[i].transform.position;
            if (Math.round(pp.x) === x && Math.round(pp.z) === z) return true;
        }
        return false;
    }

    _isEnemy(x, z) {
        var enemyColor = this._myColor === "white" ? "black" : "white";
        var pieces = this.scene.findEntitiesByTag(enemyColor) || [];
        for (var i = 0; i < pieces.length; i++) {
            var pp = pieces[i].transform.position;
            if (Math.round(pp.x) === x && Math.round(pp.z) === z) return true;
        }
        return false;
    }

    _addIfValid(moves, x, z) {
        if (x < 0 || x > 7 || z < 0 || z > 7) return false;
        if (this._isOccupiedByMe(x, z)) return false;
        var moveEntry = { x: x, z: z };
        moves.push(moveEntry);
        return !this._isOccupied(x, z);
    }

    _getValidMoves(name, px, pz) {
        var moves = [];
        var pawnDir = this._myColor === "white" ? 1 : -1;
        var pawnStartRow = this._myColor === "white" ? 1 : 6;
        if (name.indexOf("pawn") >= 0) {
            if (!this._isOccupied(px, pz + pawnDir) && pz + pawnDir >= 0 && pz + pawnDir <= 7) { var pawnFwd1 = { x: px, z: pz + pawnDir }; moves.push(pawnFwd1); }
            if (pz === pawnStartRow && !this._isOccupied(px, pz + pawnDir) && !this._isOccupied(px, pz + pawnDir * 2)) { var pawnFwd2 = { x: px, z: pz + pawnDir * 2 }; moves.push(pawnFwd2); }
            if (this._isEnemy(px - 1, pz + pawnDir)) { var pawnCapL = { x: px - 1, z: pz + pawnDir }; moves.push(pawnCapL); }
            if (this._isEnemy(px + 1, pz + pawnDir)) { var pawnCapR = { x: px + 1, z: pz + pawnDir }; moves.push(pawnCapR); }
        }
        else if (name.indexOf("rook") >= 0) {
            for (var d = 0; d < 4; d++) {
                var dx = [1, -1, 0, 0][d], dz = [0, 0, 1, -1][d];
                for (var s = 1; s <= 7; s++) { if (!this._addIfValid(moves, px + dx * s, pz + dz * s)) break; }
            }
        }
        else if (name.indexOf("bishop") >= 0) {
            for (var d = 0; d < 4; d++) {
                var dx = [1, -1, 1, -1][d], dz = [1, 1, -1, -1][d];
                for (var s = 1; s <= 7; s++) { if (!this._addIfValid(moves, px + dx * s, pz + dz * s)) break; }
            }
        }
        else if (name.indexOf("queen") >= 0) {
            for (var d = 0; d < 8; d++) {
                var dx = [1, -1, 0, 0, 1, -1, 1, -1][d], dz = [0, 0, 1, -1, 1, 1, -1, -1][d];
                for (var s = 1; s <= 7; s++) { if (!this._addIfValid(moves, px + dx * s, pz + dz * s)) break; }
            }
        }
        else if (name.indexOf("king") >= 0) {
            for (var dx2 = -1; dx2 <= 1; dx2++) {
                for (var dz2 = -1; dz2 <= 1; dz2++) {
                    if (dx2 === 0 && dz2 === 0) continue;
                    this._addIfValid(moves, px + dx2, pz + dz2);
                }
            }
        }
        else if (name.indexOf("knight") >= 0) {
            var kms = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
            for (var k = 0; k < kms.length; k++) { this._addIfValid(moves, px + kms[k][0], pz + kms[k][1]); }
        }
        return moves;
    }

    onUpdate(dt) {

        // Retry multiplayer binding (may not be ready in onStart)
        if (!this._mpBound) {
            var mp = this.scene._multiplayer;
            if (mp) {
                this._mpBound = true;
                this._isMultiplayer = true;
                this._myColor = mp.isRoomHost ? "white" : "black";
            }
        }

        if (!this._pendingClick) return;

        // In multiplayer, only allow moves on your turn
        if (this._isMultiplayer && this._turnColor !== this._myColor) {
            this._pendingClick = null;
            return;
        }

        var click = this._pendingClick;
        this._pendingClick = null;

        // Raycast to find what was clicked, use hit point for grid position
        var hit = this.scene.screenRaycast ? this.scene.screenRaycast(click.x, click.y) : null;
        var gx, gz;
        if (hit && hit.point) {
            gx = Math.round(hit.point.x);
            gz = Math.round(hit.point.z);
        } else {
            // Fallback to ground plane if raycast missed everything
            var ground = this.scene.screenPointToGround(click.x, click.y, 0.08);
            if (!ground) return;
            gx = Math.round(ground.x);
            gz = Math.round(ground.z);
        }
        if (gx < 0 || gx > 7 || gz < 0 || gz > 7) { this._clearHighlights(); this._selectedPiece = null; return; }

        var clickedPiece = null;
        var clickedIsMine = false;
        var myColor = this._myColor;
        var pieces = this.scene.findEntitiesByTag("piece") || [];
        for (var i = 0; i < pieces.length; i++) {
            var pp = pieces[i].transform.position;
            if (Math.round(pp.x) === gx && Math.round(pp.z) === gz) {
                clickedPiece = pieces[i];
                var tags = pieces[i].tags || [];
                if (typeof tags.forEach === "function") {
                    tags.forEach(function(t) { if (t === myColor) clickedIsMine = true; });
                }
                break;
            }
        }

        if (this._selectedPiece === null) {
            if (clickedPiece && clickedIsMine) {
                this._selectedPiece = clickedPiece;
                this._showHighlights(clickedPiece);
            }
        } else {
            if (clickedPiece && clickedIsMine) {
                this._selectedPiece = clickedPiece;
                this._showHighlights(clickedPiece);
            } else {
                var isValid = false;
                for (var h = 0; h < this._validMoves.length; h++) {
                    if (this._validMoves[h].x === gx && this._validMoves[h].z === gz) { isValid = true; break; }
                }
                if (isValid) {
                    var sp = this._selectedPiece.transform.position;
                    var fromX = Math.round(sp.x), fromZ = Math.round(sp.z);
                    this.scene.setPosition(this._selectedPiece.id, gx, sp.y, gz);
                    if (clickedPiece && !clickedIsMine) { this.scene.destroyEntity(clickedPiece.id); this.scene._chessCheckKings = true; }
                    // Emit move for multiplayer sync
                    var moveData = {};
                    moveData.from = { x: fromX, z: fromZ };
                    moveData.to = { x: gx, z: gz };
                    moveData.color = this._myColor;
                    moveData.piece = this._selectedPiece.name;
                    this.scene.events.game.emit("chess_move_made", moveData);
                    this._clearHighlights();
                    this._selectedPiece = null;
                    var _ed1 = {}; this.scene.events.game.emit("move_made", _ed1);
                } else {
                    this._clearHighlights();
                    this._selectedPiece = null;
                }
            }
        }
    }
}
