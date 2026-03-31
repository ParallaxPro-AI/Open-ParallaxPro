import { EditorContext } from '../editor_context.js';
import { DeleteEntityCommand, CreateEntityCommand, BatchCommand } from '../history/commands.js';

/**
 * Global keyboard shortcut handler for the editor.
 */
export class ShortcutManager {
    private ctx: EditorContext;

    constructor() {
        this.ctx = EditorContext.instance;
        window.addEventListener('keydown', this.onKeyDown);
    }

    destroy(): void {
        window.removeEventListener('keydown', this.onKeyDown);
    }

    private onKeyDown = (e: KeyboardEvent): void => {
        const target = e.target as HTMLElement;
        if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') {
            if (e.key !== 'Escape' && !(e.ctrlKey || e.metaKey)) return;
            if (e.key !== 'Escape' && e.key !== 's' && e.key.toLowerCase() !== 'z' && e.key !== 'y') return;
        }

        const ctrl = e.ctrlKey || e.metaKey;

        // During play mode, only handle Ctrl+P (toggle play)
        if (this.ctx.state.isPlaying) {
            if (ctrl && e.key.toLowerCase() === 'p') {
                e.preventDefault();
                this.ctx.togglePlayMode();
            }
            return;
        }

        // Transform mode shortcuts
        if (!ctrl && !e.altKey) {
            switch (e.key.toLowerCase()) {
                case '1':
                    if (!this.isTypingContext(target)) {
                        this.ctx.setGizmoMode('translate');
                        e.preventDefault();
                    }
                    return;
                case '2':
                    if (!this.isTypingContext(target)) {
                        this.ctx.setGizmoMode('rotate');
                        e.preventDefault();
                    }
                    return;
                case '3':
                    if (!this.isTypingContext(target)) {
                        this.ctx.setGizmoMode('scale');
                        e.preventDefault();
                    }
                    return;
                case '4':
                    if (!this.isTypingContext(target)) {
                        this.ctx.toggleCameraMode();
                        e.preventDefault();
                    }
                    return;
                case '5':
                    if (!this.isTypingContext(target)) {
                        this.ctx.toggleGizmoSpace();
                        e.preventDefault();
                    }
                    return;
                case 'f':
                    if (!this.isTypingContext(target)) {
                        const selected = this.ctx.state.selectedEntityIds;
                        if (selected.length > 0) {
                            this.ctx.focusEntity(selected[0]);
                        }
                        e.preventDefault();
                    }
                    return;
            }
        }

        if (e.key === 'Escape') {
            if (!this.ctx.state.isPlaying) {
                this.ctx.clearSelection();
            }
            e.preventDefault();
            return;
        }

        // Delete selected entities
        if (e.key === 'Delete' || e.key === 'Backspace') {
            if (this.isTypingContext(target)) return;
            const selected = [...this.ctx.state.selectedEntityIds];
            if (selected.length > 0) {
                const commands = selected.map(id => new DeleteEntityCommand(id));
                const batch = new BatchCommand('Delete Entities', commands);
                this.ctx.undoManager.execute(batch);
                this.ctx.emit('historyChanged');
                e.preventDefault();
            }
            return;
        }

        // Ctrl shortcuts
        if (ctrl) {
            switch (e.key.toLowerCase()) {
                case 's':
                    e.preventDefault();
                    this.ctx.saveProject();
                    return;
                case 'z':
                    e.preventDefault();
                    if (e.shiftKey) {
                        this.ctx.undoManager.redo();
                    } else {
                        this.ctx.undoManager.undo();
                    }
                    this.ctx.emit('historyChanged');
                    this.ctx.emit('sceneChanged');
                    this.ctx.ensurePrimitiveMeshes();
                    return;
                case 'y':
                    e.preventDefault();
                    this.ctx.undoManager.redo();
                    this.ctx.emit('historyChanged');
                    this.ctx.emit('sceneChanged');
                    this.ctx.ensurePrimitiveMeshes();
                    return;
                case 'd':
                    e.preventDefault();
                    this.duplicateSelected();
                    return;
                case 'a':
                    if (this.isTypingContext(target)) return;
                    e.preventDefault();
                    this.selectAll();
                    return;
                case 'p':
                    e.preventDefault();
                    this.ctx.togglePlayMode();
                    return;
            }
        }
    };

    private isTypingContext(el: HTMLElement): boolean {
        return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable;
    }

    private duplicateSelected(): void {
        const scene = this.ctx.getActiveScene();
        if (!scene) return;

        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0) return;

        const commands: CreateEntityCommand[] = [];
        for (const entity of selected) {
            const data = entity.toJSON();
            const compData = data.components?.map((c: any) => ({ type: c.type, data: c.data }));
            const cmd = new CreateEntityCommand(
                `${entity.name} (copy)`,
                entity.parent ? entity.parent.id : null,
                compData,
            );
            commands.push(cmd);
        }

        const batch = new BatchCommand('Duplicate', commands);
        this.ctx.undoManager.execute(batch);
        this.ctx.emit('historyChanged');

        const newIds = commands.map(c => c.getCreatedEntityId()).filter(id => id >= 0);
        if (newIds.length > 0) {
            this.ctx.setSelection(newIds);
        }
    }

    private selectAll(): void {
        const scene = this.ctx.getActiveScene();
        if (!scene) return;
        const allIds = Array.from(scene.entities.keys());
        this.ctx.setSelection(allIds);
    }
}
