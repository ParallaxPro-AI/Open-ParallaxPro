// Chess engine — AI opponent with proper move rules
class ChessEngineSystem extends GameScript {
    _systemName = "chess_engine";
    _active = false;

    onStart() {
        var self = this;
        this.scene.events.game.on("active_systems", function(d) {
            self._active = d.systems && d.systems.indexOf(self._systemName) >= 0;
        });
        this.scene.events.game.on("ai_turn", function() {
            self._makeAiMove();
        });

        // Multiplayer: apply a move received from the remote player
        this.scene.events.game.on("apply_remote_move", function(data) {
            if (!data || data.from === undefined || data.to === undefined) return;
            // Find the piece at the 'from' position
            var color = data.color || "black";
            var pieces = self.scene.findEntitiesByTag(color) || [];
            var fromX = data.from.x, fromZ = data.from.z;
            var toX = data.to.x, toZ = data.to.z;
            var piece = null;
            for (var i = 0; i < pieces.length; i++) {
                var pp = pieces[i].transform.position;
                if (Math.round(pp.x) === fromX && Math.round(pp.z) === fromZ) {
                    piece = pieces[i];
                    break;
                }
            }
            if (!piece) return;

            // Capture opponent piece if present
            var oppColor = color === "white" ? "black" : "white";
            var oppPieces = self.scene.findEntitiesByTag(oppColor) || [];
            for (var j = 0; j < oppPieces.length; j++) {
                var op = oppPieces[j].transform.position;
                if (Math.round(op.x) === toX && Math.round(op.z) === toZ) {
                    self.scene.destroyEntity(oppPieces[j].id);
                    break;
                }
            }

            // Move the piece
            var py = piece.transform.position.y;
            self.scene.setPosition(piece.id, toX, py, toZ);

            // Emit moveMade so FSM transitions turns
            var moveEvt = {};
            self.scene.events.game.emit("move_made", moveEvt);
        });
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

        if (allMoves.length === 0) return;

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
    }

    onUpdate(dt) {}
}
