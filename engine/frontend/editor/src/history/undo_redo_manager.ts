import { Command } from './commands.js';

/**
 * Classic undo/redo stack manager.
 *
 * - execute() pushes a command and runs it.
 * - undo() reverts the last command.
 * - redo() re-applies the last undone command.
 * - Executing a new command clears the redo stack.
 */
export class UndoRedoManager {
    private undoStack: Command[] = [];
    private redoStack: Command[] = [];
    private maxHistory: number = 100;
    private onChangeCallback: (() => void) | null = null;

    /** Register a callback that fires whenever the undo/redo stacks change. */
    onChange(callback: () => void): void {
        this.onChangeCallback = callback;
    }

    /** Execute a command: run it, push to undo stack, clear redo stack. */
    execute(command: Command): void {
        command.execute();
        this.undoStack.push(command);
        this.redoStack.length = 0;

        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }

        this.notifyChange();
    }

    /**
     * Push a command onto the undo stack without executing it.
     * Useful when the action has already been applied (e.g. gizmo drag).
     */
    push(command: Command): void {
        this.undoStack.push(command);
        this.redoStack.length = 0;

        if (this.undoStack.length > this.maxHistory) {
            this.undoStack.shift();
        }

        this.notifyChange();
    }

    undo(): void {
        const cmd = this.undoStack.pop();
        if (cmd) {
            cmd.undo();
            this.redoStack.push(cmd);
            this.notifyChange();
        }
    }

    redo(): void {
        const cmd = this.redoStack.pop();
        if (cmd) {
            cmd.execute();
            this.undoStack.push(cmd);
            this.notifyChange();
        }
    }

    canUndo(): boolean {
        return this.undoStack.length > 0;
    }

    canRedo(): boolean {
        return this.redoStack.length > 0;
    }

    getUndoLabel(): string {
        if (this.undoStack.length === 0) return '';
        return this.undoStack[this.undoStack.length - 1].label;
    }

    getRedoLabel(): string {
        if (this.redoStack.length === 0) return '';
        return this.redoStack[this.redoStack.length - 1].label;
    }

    clear(): void {
        this.undoStack.length = 0;
        this.redoStack.length = 0;
        this.notifyChange();
    }

    private notifyChange(): void {
        if (this.onChangeCallback) {
            this.onChangeCallback();
        }
    }
}
