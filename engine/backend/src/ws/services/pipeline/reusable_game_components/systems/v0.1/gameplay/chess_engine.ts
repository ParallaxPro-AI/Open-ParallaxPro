// also: turn-based strategy, piece logic, valid moves, board game AI
// Chess engine — AI opponent with proper move rules
class ChessEngineSystem extends GameScript {
    // Snapshot of every piece's starting transform, captured on first
    // onStart. Restored on restart_game so Play Again actually resets
    // the board — without this, captured pieces stayed deactivated and
    // surviving pieces stayed wherever they finished the previous match,
    // so "Play Again" started mid-checkmate.
    _initialPieces = [];

    onStart() {
        var self = this;
        this.scene.events.game.on("ai_turn", function() {
            self._makeAiMove();
        });

        // Capture board state once. The pieces are placed in 03_worlds.json
        // so this fires on the very first tick after world load.
        this._captureInitialBoard();

        // Restore board on Play Again.
        this.scene.events.game.on("restart_game", function() { self._restoreInitialBoard(); });
        this.scene.events.game.on("game_ready", function() { self._restoreInitialBoard(); });
    }

    _captureInitialBoard() {
        var pieces = this.scene.findEntitiesByTag("piece") || [];
        this._initialPieces = [];
        for (var i = 0; i < pieces.length; i++) {
            var p = pieces[i];
            if (!p) continue;
            var pos = p.transform && p.transform.position;
            if (!pos) continue;
            this._initialPieces.push({ id: p.id, x: pos.x, y: pos.y, z: pos.z });
        }
    }

    _restoreInitialBoard() {
        for (var i = 0; i < this._initialPieces.length; i++) {
            var s = this._initialPieces[i];
            var ent = this.scene.getEntity ? this.scene.getEntity(s.id) : null;
            // Some scenes proxy entities via findEntityByName; fall back if needed.
            if (!ent && this.scene.getAllEntities) {
                var all = this.scene.getAllEntities();
                for (var k = 0; k < all.length; k++) {
                    if (all[k].id === s.id) { ent = all[k]; break; }
                }
            }
            if (!ent) continue;
            ent.active = true;
            if (this.scene.setPosition) this.scene.setPosition(s.id, s.x, s.y, s.z);
        }
    }

    _isOccupiedByBlack(x, z) {
        var pieces = this.scene.findEntitiesByTag("black") || [];
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

    _isWhite(x, z) {
        var pieces = this.scene.findEntitiesByTag("white") || [];
        for (var i = 0; i < pieces.length; i++) {
            var pp = pieces[i].transform.position;
            if (Math.round(pp.x) === x && Math.round(pp.z) === z) return true;
        }
        return false;
    }

    _addIfValid(moves, x, z) {
        if (x < 0 || x > 7 || z < 0 || z > 7) return false;
        if (this._isOccupiedByBlack(x, z)) return false;
        var moveEntry = { x: x, z: z };
        moves.push(moveEntry);
        return !this._isOccupied(x, z);
    }

    _getMovesForPiece(name, px, pz) {
        var moves = [];
        if (name.indexOf("pawn") >= 0) {
            // Black pawns move in -z direction
            if (!this._isOccupied(px, pz - 1) && pz - 1 >= 0) { var pawnMove1 = { x: px, z: pz - 1 }; moves.push(pawnMove1); }
            if (pz === 6 && !this._isOccupied(px, pz - 1) && !this._isOccupied(px, pz - 2)) { var pawnMove2 = { x: px, z: pz - 2 }; moves.push(pawnMove2); }
            if (this._isWhite(px - 1, pz - 1)) { var pawnCapL = { x: px - 1, z: pz - 1 }; moves.push(pawnCapL); }
            if (this._isWhite(px + 1, pz - 1)) { var pawnCapR = { x: px + 1, z: pz - 1 }; moves.push(pawnCapR); }
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
            for (var k = 0; k < kms.length; k++) {
                this._addIfValid(moves, px + kms[k][0], pz + kms[k][1]);
            }
        }
        return moves;
    }

    _makeAiMove() {
        var blacks = this.scene.findEntitiesByTag("black") || [];
        if (blacks.length === 0) return;

        // Collect all possible moves for all black pieces
        var allMoves = [];
        for (var i = 0; i < blacks.length; i++) {
            var pos = blacks[i].transform.position;
            var px = Math.round(pos.x);
            var pz = Math.round(pos.z);
            var name = blacks[i].name.toLowerCase();
            var pieceMoves = this._getMovesForPiece(name, px, pz);
            for (var j = 0; j < pieceMoves.length; j++) {
                // Prefer captures
                var isCapture = this._isWhite(pieceMoves[j].x, pieceMoves[j].z);
                var aiMoveEntry = { piece: blacks[i], move: pieceMoves[j], capture: isCapture };
                allMoves.push(aiMoveEntry);
            }
        }

        if (allMoves.length === 0) {
            // No legal moves — check if it's stalemate or checkmate
            // Simplified: if the black king is under attack, it's checkmate (white wins)
            // otherwise it's stalemate (draw)
            var blackKing = null;
            for (var bk = 0; bk < blacks.length; bk++) {
                if (blacks[bk].name.toLowerCase().indexOf("king") >= 0) { blackKing = blacks[bk]; break; }
            }
            if (blackKing) {
                var kPos = blackKing.transform.position;
                var kx = Math.round(kPos.x), kz = Math.round(kPos.z);
                // Check if any white piece can attack the king's square
                var whites = this.scene.findEntitiesByTag("white") || [];
                var inCheck = false;
                for (var wc = 0; wc < whites.length; wc++) {
                    var wPos = whites[wc].transform.position;
                    var wName = whites[wc].name.toLowerCase();
                    // Simple proximity check for attack
                    var wdx = Math.abs(Math.round(wPos.x) - kx);
                    var wdz = Math.abs(Math.round(wPos.z) - kz);
                    if (wdx <= 2 && wdz <= 2) { inCheck = true; break; }
                }
                if (inCheck) {
                    this.scene.events.game.emit("checkmate", {});
                } else {
                    this.scene.events.game.emit("stalemate", {});
                }
            } else {
                // No king found — checkmate
                this.scene.events.game.emit("checkmate", {});
            }
            return;
        }

        // Prefer captures, otherwise random
        var captures = allMoves.filter(function(m) { return m.capture; });
        var chosen = captures.length > 0
            ? captures[Math.floor(Math.random() * captures.length)]
            : allMoves[Math.floor(Math.random() * allMoves.length)];

        var piece = chosen.piece;
        var target = chosen.move;

        // Capture white piece if present
        if (chosen.capture) {
            var whites = this.scene.findEntitiesByTag("white") || [];
            for (var w = 0; w < whites.length; w++) {
                var wp = whites[w].transform.position;
                if (Math.round(wp.x) === target.x && Math.round(wp.z) === target.z) {
                    this.scene.destroyEntity(whites[w].id);
                    break;
                }
            }
        }

        var py = piece.transform.position.y;
        this.scene.setPosition(piece.id, target.x, py, target.z);

        // After AI move, check if white king was captured
        this._checkKingAlive();

        // Emit move_made for FSM turn transition
        this.scene.events.game.emit("move_made", {});
    }

    _checkKingAlive() {
        // Check white king
        var whites = this.scene.findEntitiesByTag("white") || [];
        var whiteKingAlive = false;
        for (var w = 0; w < whites.length; w++) {
            if (!whites[w].active) continue;
            if (whites[w].name.toLowerCase().indexOf("king") >= 0) { whiteKingAlive = true; break; }
        }
        if (!whiteKingAlive && whites.length > 0) {
            // Player's king captured — AI wins
            this.scene.events.game.emit("checkmate", {});
            return;
        }

        // Check black king
        var blacks = this.scene.findEntitiesByTag("black") || [];
        var blackKingAlive = false;
        for (var b = 0; b < blacks.length; b++) {
            if (!blacks[b].active) continue;
            if (blacks[b].name.toLowerCase().indexOf("king") >= 0) { blackKingAlive = true; break; }
        }
        if (!blackKingAlive && blacks.length > 0) {
            // AI's king captured — player wins
            this.scene.events.game.emit("checkmate", {});
        }
    }

    onUpdate(dt) {
        // Also check kings each frame (in case chess_interaction captures a king)
        if (this.scene._chessCheckKings) {
            this.scene._chessCheckKings = false;
            this._checkKingAlive();
        }
    }
}
