import { EditorContext } from '../editor_context.js';
import { Entity } from '../../../runtime/function/framework/entity.js';
import { showContextMenu } from '../widgets/context_menu.js';
import { addDefaultSceneEntities } from '../default_scene.js';
import {
    CreateEntityCommand,
    DeleteEntityCommand,
    RenameEntityCommand,
    ReparentEntityCommand,
    ReorderEntityCommand,
    BatchCommand,
    AddComponentCommand,
} from '../history/commands.js';
import { icon, Box, Circle, Square, Sun, Camera, Volume2, Sparkles, Layers, Lightbulb, Eye, EyeOff, Plus, Globe } from '../widgets/icons.js';
import { buildComponentsForAsset, prettifyAssetName } from '../utils/asset_drop.js';
import { t } from '../i18n/index.js';

/**
 * Scene hierarchy panel: shows entity tree with drag-and-drop reparenting,
 * search/filter, context menus, and add-entity dropdown.
 */
export class SceneHierarchyPanel {
    readonly el: HTMLElement;
    private ctx: EditorContext;
    private treeContainer: HTMLElement;
    private searchInput: HTMLInputElement;
    private addDropdown: HTMLElement | null = null;
    private searchTerm: string = '';
    private dragSourceId: number | null = null;
    private collapsedScenes: Set<number> = new Set();
    private lastClickedEntityId: number | null = null;

    constructor() {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'panel hierarchy-panel';
        this.el.style.flex = '1';

        // Header
        const header = document.createElement('div');
        header.className = 'panel-header';

        const title = document.createElement('span');
        title.className = 'panel-title';
        title.textContent = t('hierarchy.title');
        header.appendChild(title);

        const addBtn = document.createElement('button');
        addBtn.className = 'icon-btn';
        addBtn.appendChild(icon(Plus, 14));
        addBtn.title = t('hierarchy.addEntity');
        addBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showAddDropdown(addBtn);
        });
        header.appendChild(addBtn);

        this.el.appendChild(header);

        // Search bar
        const searchBar = document.createElement('div');
        searchBar.className = 'panel-search';
        this.searchInput = document.createElement('input');
        this.searchInput.type = 'text';
        this.searchInput.placeholder = t('hierarchy.searchEntities');
        this.searchInput.addEventListener('input', () => {
            this.searchTerm = this.searchInput.value.toLowerCase();
            this.render();
        });
        searchBar.appendChild(this.searchInput);
        this.el.appendChild(searchBar);

        // Tree container
        this.treeContainer = document.createElement('div');
        this.treeContainer.className = 'hierarchy-tree';
        this.el.appendChild(this.treeContainer);

        // Click empty space to deselect
        this.treeContainer.addEventListener('click', (e) => {
            if (e.target === this.treeContainer) {
                this.ctx.state.selectedSceneId = null;
                this.ctx.clearSelection();
            }
        });

        // Accept asset drops onto the hierarchy
        this.treeContainer.addEventListener('dragover', (e) => {
            if (e.dataTransfer?.types.includes('application/x-parallax-asset')) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                this.treeContainer.classList.add('drag-over-asset');
            }
        });

        this.treeContainer.addEventListener('dragleave', (e) => {
            if (!(e.relatedTarget as Node)?.parentElement?.closest('.hierarchy-tree')) {
                this.treeContainer.classList.remove('drag-over-asset');
            }
        });

        this.treeContainer.addEventListener('drop', (e) => {
            this.treeContainer.classList.remove('drag-over-asset');
            const json = e.dataTransfer?.getData('application/x-parallax-asset');
            if (!json) return;
            e.preventDefault();
            try {
                const asset = JSON.parse(json);
                if (asset.fileUrl) this.ctx.assetMeta.set(asset.fileUrl, asset);
                const components = buildComponentsForAsset(asset);
                const name = prettifyAssetName(asset.name);
                const cmd = new CreateEntityCommand(name, null, components);
                this.ctx.undoManager.execute(cmd);
                this.ctx.emit('historyChanged');
                this.ctx.ensurePrimitiveMeshes();
            } catch { /* ignore */ }
        });

        // Listen for context changes
        this.ctx.on('sceneChanged', () => this.render());
        this.ctx.on('selectionChanged', () => this.updateSelection());
        this.ctx.on('entityCreated', () => this.render());
        this.ctx.on('entityDeleted', () => this.render());
        this.ctx.on('entityRenamed', () => this.render());
        this.ctx.on('entityReparented', () => this.render());

        // Refresh active states during play mode
        let playModeInterval: ReturnType<typeof setInterval> | null = null;
        this.ctx.on('playModeChanged', (isPlaying: boolean) => {
            if (isPlaying) {
                playModeInterval = setInterval(() => this.refreshActiveStates(), 500);
            } else {
                if (playModeInterval) { clearInterval(playModeInterval); playModeInterval = null; }
                this.render();
            }
        });

        this.render();
    }

    render(): void {
        this.treeContainer.innerHTML = '';

        const wm = this.ctx.engine?.globalContext.worldManager;
        if (!wm) {
            const empty = document.createElement('div');
            empty.className = 'panel-empty';
            empty.textContent = t('hierarchy.noSceneLoaded');
            this.treeContainer.appendChild(empty);
            return;
        }

        const scenes = wm.getLoadedScenes();
        const activeScene = wm.getActiveScene();

        if (scenes.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'panel-empty';
            empty.textContent = t('hierarchy.noSceneLoaded');
            this.treeContainer.appendChild(empty);
            return;
        }

        for (const scene of scenes) {
            this.renderSceneNode(scene, scene === activeScene);
        }
    }

    private renderSceneNode(scene: any, isActive: boolean): void {
        const isCollapsed = this.collapsedScenes.has(scene.id);
        const roots = scene.getRootEntities();
        const hasChildren = roots.length > 0;

        const row = document.createElement('div');
        row.className = 'tree-node scene-node';
        row.dataset.sceneId = String(scene.id);
        if (isActive) row.classList.add('active-scene');
        if (this.ctx.state.selectedSceneId === scene.id && this.ctx.state.selectedEntityIds.length === 0) {
            row.classList.add('selected');
        }

        const expand = document.createElement('span');
        expand.className = 'tree-node-expand';
        if (hasChildren) {
            expand.textContent = '\u25BC';
            if (isCollapsed) expand.classList.add('collapsed');
            expand.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.collapsedScenes.has(scene.id)) {
                    this.collapsedScenes.delete(scene.id);
                } else {
                    this.collapsedScenes.add(scene.id);
                }
                this.render();
            });
        }
        row.appendChild(expand);

        const iconContainer = document.createElement('span');
        iconContainer.className = 'tree-node-icon';
        iconContainer.appendChild(icon(Globe, 13));
        row.appendChild(iconContainer);

        const name = document.createElement('span');
        name.className = 'tree-node-name scene-name';
        name.textContent = scene.name || t('assets.untitledScene');
        row.appendChild(name);

        row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!isActive) {
                const wm = this.ctx.engine?.globalContext.worldManager;
                if (wm) {
                    wm.setActiveScene(scene.id);
                    this.ctx.engine!.setActiveScene(scene);
                    this.ctx.emit('sceneChanged');
                }
            }
            this.ctx.selectScene(scene.id);
        });

        row.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.startSceneRename(scene, name);
        });

        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.showSceneContextMenu(scene, e.clientX, e.clientY);
        });

        this.treeContainer.appendChild(row);

        if (hasChildren && !isCollapsed) {
            for (const entity of roots) {
                this.renderEntity(entity, 1, scene, isActive);
            }
        }
    }

    private startSceneRename(scene: any, nameEl: HTMLElement): void {
        const oldName = scene.name || t('assets.untitledScene');
        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = oldName;

        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim() || oldName;
            if (newName !== oldName) {
                const oldKey = this.ctx.getSceneKey(scene);
                const oldData = this.ctx.state.projectData?.scenes?.[oldKey];
                if (this.ctx.state.projectData?.scenes) {
                    delete this.ctx.state.projectData.scenes[oldKey];
                }
                scene.name = newName;
                const newKey = this.ctx.getSceneKey(scene);
                if (this.ctx.state.projectData?.scenes) {
                    this.ctx.state.projectData.scenes[newKey] = oldData ?? scene.toJSON();
                }
                this.ctx.markDirty();
            } else {
                scene.name = newName;
            }
            this.render();
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            } else if (e.key === 'Escape') {
                committed = true;
                nameEl.textContent = oldName;
                input.remove();
            }
        });
    }

    private showSceneContextMenu(scene: any, x: number, y: number): void {
        const wm = this.ctx.engine?.globalContext.worldManager;
        const scenes = wm?.getLoadedScenes() ?? [];
        showContextMenu(x, y, [
            {
                label: t('hierarchy.rename'),
                shortcut: 'Double-click',
                action: () => {
                    const nameEl = this.treeContainer.querySelector('.scene-node.active-scene .scene-name, .scene-node .scene-name') as HTMLElement;
                    if (nameEl) this.startSceneRename(scene, nameEl);
                },
            },
            { label: '', separator: true },
            {
                label: t('hierarchy.deleteScene'),
                danger: true,
                disabled: scenes.length <= 1,
                action: () => {
                    if (scenes.length <= 1) return;
                    if (wm) {
                        const sceneKey = this.ctx.getSceneKey(scene);
                        if (this.ctx.state.projectData?.scenes) {
                            delete this.ctx.state.projectData.scenes[sceneKey];
                        }
                        const wasActive = wm.getActiveScene()?.id === scene.id;
                        wm.unloadScene(scene.id);
                        if (wasActive) {
                            const remaining = wm.getLoadedScenes();
                            if (remaining.length > 0) {
                                wm.setActiveScene(remaining[0].id);
                                this.ctx.engine!.setActiveScene(remaining[0] as any);
                            }
                        }
                        this.ctx.markDirty();
                        this.ctx.emit('sceneChanged');
                    }
                },
            },
        ]);
    }

    private renderEntity(entity: Entity, depth: number, ownerScene?: any, isSceneActive?: boolean): void {
        // Hide internal system entities
        if (entity.tags.has('#managers_root') || entity.tags.has('#manager')) return;

        if (this.searchTerm) {
            if (!this.entityMatchesSearch(entity)) return;
        }

        const isSelected = this.ctx.state.selectedEntityIds.includes(entity.id);
        const isCollapsed = this.ctx.state.collapsedEntities.has(entity.id);
        const isHidden = this.ctx.state.hiddenEntities.has(entity.id);
        const hasChildren = entity.children.length > 0;

        const row = document.createElement('div');
        row.className = 'tree-node';
        if (isSelected) row.classList.add('selected');
        row.dataset.entityId = String(entity.id);
        row.draggable = true;

        // Indentation
        for (let i = 0; i < depth; i++) {
            const indent = document.createElement('span');
            indent.className = 'tree-node-indent';
            row.appendChild(indent);
        }

        // Expand/collapse arrow
        const expand = document.createElement('span');
        expand.className = 'tree-node-expand';
        if (hasChildren) {
            expand.textContent = '\u25BC';
            if (isCollapsed) expand.classList.add('collapsed');
            expand.addEventListener('click', (e) => {
                e.stopPropagation();
                if (this.ctx.state.collapsedEntities.has(entity.id)) {
                    this.ctx.state.collapsedEntities.delete(entity.id);
                } else {
                    this.ctx.state.collapsedEntities.add(entity.id);
                }
                this.render();
            });
        }
        row.appendChild(expand);

        // Entity icon
        const iconContainer = document.createElement('span');
        iconContainer.className = 'tree-node-icon';
        const iconEl = this.getEntityIconEl(entity);
        if (iconEl) iconContainer.appendChild(iconEl);
        row.appendChild(iconContainer);

        // Entity name
        const nameEl = document.createElement('span');
        nameEl.className = 'tree-node-name';
        let effectivelyInactive = !entity.active;
        if (!effectivelyInactive) {
            let cur = entity.parent;
            while (cur) { if (!cur.active) { effectivelyInactive = true; break; } cur = cur.parent; }
        }
        if (effectivelyInactive) nameEl.classList.add('inactive');
        nameEl.textContent = entity.name;
        row.appendChild(nameEl);

        // Visibility toggle
        const actions = document.createElement('div');
        actions.className = 'tree-node-actions';

        const visBtn = document.createElement('span');
        visBtn.className = 'tree-node-action';
        if (isHidden) visBtn.classList.add('hidden-entity');
        visBtn.appendChild(icon(isHidden ? EyeOff : Eye, 12));
        visBtn.title = isHidden ? t('hierarchy.show') : t('hierarchy.hide');
        visBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.ctx.toggleVisibility(entity.id);
        });
        actions.appendChild(visBtn);
        row.appendChild(actions);

        // Click to select
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            if (ownerScene && !isSceneActive) {
                const wm = this.ctx.engine?.globalContext.worldManager;
                if (wm) {
                    wm.setActiveScene(ownerScene.id);
                    this.ctx.engine!.setActiveScene(ownerScene);
                    this.ctx.emit('sceneChanged');
                }
            }
            if (e.ctrlKey || e.metaKey) {
                this.ctx.toggleSelection(entity.id);
                this.lastClickedEntityId = entity.id;
            } else if (e.shiftKey && this.lastClickedEntityId !== null) {
                const order = this.getVisibleEntityOrder();
                const fromIdx = order.indexOf(this.lastClickedEntityId);
                const toIdx = order.indexOf(entity.id);
                if (fromIdx !== -1 && toIdx !== -1) {
                    const lo = Math.min(fromIdx, toIdx);
                    const hi = Math.max(fromIdx, toIdx);
                    this.ctx.setSelection(order.slice(lo, hi + 1));
                } else {
                    this.ctx.addToSelection(entity.id);
                }
            } else {
                this.ctx.setSelection([entity.id]);
                this.lastClickedEntityId = entity.id;
            }
        });

        // Double-click to rename
        row.addEventListener('dblclick', (e) => {
            e.stopPropagation();
            this.startRename(entity, nameEl);
        });

        // Context menu
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!this.ctx.state.selectedEntityIds.includes(entity.id)) {
                this.ctx.setSelection([entity.id]);
                this.lastClickedEntityId = entity.id;
            }
            if (this.ctx.state.selectedEntityIds.length > 1) {
                this.showMultiEntityContextMenu(e.clientX, e.clientY);
            } else {
                this.showEntityContextMenu(entity, e.clientX, e.clientY);
            }
        });

        // Drag-and-drop
        row.addEventListener('dragstart', (e) => {
            if (this.ctx.state.selectedEntityIds.includes(entity.id)) {
                this.dragSourceId = entity.id;
            } else {
                this.dragSourceId = entity.id;
                this.ctx.setSelection([entity.id]);
                this.lastClickedEntityId = entity.id;
            }
            if (e.dataTransfer) {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(entity.id));
            }
        });

        row.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (this.dragSourceId !== null && this.ctx.state.selectedEntityIds.includes(entity.id)) return;
            row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside');

            const rect = row.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const third = rect.height / 3;

            if (y < third) {
                row.classList.add('drag-over-above');
            } else if (y > rect.height - third) {
                row.classList.add('drag-over-below');
            } else {
                row.classList.add('drag-over-inside');
            }
        });

        row.addEventListener('dragleave', () => {
            row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside');
        });

        row.addEventListener('drop', (e) => {
            e.preventDefault();
            row.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside');

            // Handle asset drops onto entity rows
            const assetJson = e.dataTransfer?.getData('application/x-parallax-asset');
            if (assetJson) {
                try {
                    const asset = JSON.parse(assetJson);
                    if (asset.fileUrl) this.ctx.assetMeta.set(asset.fileUrl, asset);

                    if (asset.category === 'Scripts') {
                        const cmd = new AddComponentCommand(entity.id, 'ScriptComponent', { scriptURL: asset.fileUrl });
                        this.ctx.undoManager.execute(cmd);
                        this.ctx.emit('historyChanged');
                    } else {
                        const components = buildComponentsForAsset(asset);
                        const assetName = prettifyAssetName(asset.name);
                        const cmd = new CreateEntityCommand(assetName, entity.id, components);
                        this.ctx.undoManager.execute(cmd);
                        this.ctx.emit('historyChanged');
                        this.ctx.ensurePrimitiveMeshes();
                        this.ctx.state.collapsedEntities.delete(entity.id);
                    }
                } catch { /* ignore */ }
                return;
            }

            if (this.dragSourceId === null || this.dragSourceId === entity.id) return;

            const rect = row.getBoundingClientRect();
            const y = e.clientY - rect.top;
            const third = rect.height / 3;

            const scene = this.ctx.getActiveScene();
            if (!scene) return;

            let newParentId: number | null;
            let siblingIndex: number;

            if (y < third) {
                newParentId = entity.parent ? entity.parent.id : null;
                const siblings = entity.parent ? entity.parent.children : scene.getRootEntities();
                siblingIndex = siblings.findIndex((s: Entity) => s.id === entity.id);
            } else if (y > rect.height - third) {
                newParentId = entity.parent ? entity.parent.id : null;
                const siblings = entity.parent ? entity.parent.children : scene.getRootEntities();
                siblingIndex = siblings.findIndex((s: Entity) => s.id === entity.id) + 1;
            } else {
                newParentId = entity.id;
                siblingIndex = entity.children.length;
            }

            const dragIds = this.ctx.state.selectedEntityIds.includes(this.dragSourceId)
                ? [...this.ctx.state.selectedEntityIds]
                : [this.dragSourceId];
            const validIds = dragIds.filter(id => {
                if (id === entity.id) return false;
                let parent = entity.parent;
                while (parent) {
                    if (parent.id === id) return false;
                    parent = parent.parent;
                }
                return true;
            });

            if (validIds.length > 0) {
                const commands = validIds.map(id => new ReorderEntityCommand(id, newParentId, siblingIndex));
                if (commands.length === 1) {
                    this.ctx.undoManager.execute(commands[0]);
                } else {
                    this.ctx.undoManager.execute(new BatchCommand('Reparent Entities', commands));
                }
                this.ctx.emit('historyChanged');
            }
            this.dragSourceId = null;
        });

        row.addEventListener('dragend', () => {
            this.dragSourceId = null;
            this.treeContainer.querySelectorAll('.tree-node').forEach(n =>
                n.classList.remove('drag-over-above', 'drag-over-below', 'drag-over-inside')
            );
        });

        this.treeContainer.appendChild(row);

        // Render children
        if (hasChildren && !isCollapsed) {
            for (const child of entity.children) {
                this.renderEntity(child, depth + 1, ownerScene, isSceneActive);
            }
        }
    }

    private entityMatchesSearch(entity: Entity): boolean {
        if (entity.name.toLowerCase().includes(this.searchTerm)) return true;
        for (const child of entity.children) {
            if (this.entityMatchesSearch(child)) return true;
        }
        return false;
    }

    private updateSelection(): void {
        const rows = this.treeContainer.querySelectorAll('.tree-node');
        rows.forEach(row => {
            const htmlRow = row as HTMLElement;
            if (htmlRow.classList.contains('scene-node')) {
                const sceneId = parseInt(htmlRow.dataset.sceneId ?? '-1');
                row.classList.toggle('selected',
                    this.ctx.state.selectedSceneId === sceneId && this.ctx.state.selectedEntityIds.length === 0);
            } else {
                const id = parseInt(htmlRow.dataset.entityId ?? '-1');
                row.classList.toggle('selected', this.ctx.state.selectedEntityIds.includes(id));
            }
        });
    }

    private getEntityIconEl(entity: Entity): SVGElement | null {
        if (entity.hasComponent('CameraComponent')) return icon(Camera, 13);
        if (entity.hasComponent('LightComponent')) return icon(Sun, 13);
        if (entity.hasComponent('MeshRendererComponent')) return icon(Box, 13);
        if (entity.hasComponent('AudioSourceComponent')) return icon(Volume2, 13);
        return icon(Layers, 13);
    }

    private startRename(entity: Entity, nameEl: HTMLElement): void {
        const oldName = entity.name;
        const input = document.createElement('input');
        input.className = 'rename-input';
        input.value = oldName;

        nameEl.textContent = '';
        nameEl.appendChild(input);
        input.focus();
        input.select();

        let committed = false;
        const commit = () => {
            if (committed) return;
            committed = true;
            const newName = input.value.trim() || oldName;
            if (newName !== oldName) {
                const cmd = new RenameEntityCommand(entity.id, oldName, newName);
                this.ctx.undoManager.execute(cmd);
                this.ctx.emit('historyChanged');
            } else {
                nameEl.textContent = entity.name;
            }
        };

        input.addEventListener('blur', commit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            } else if (e.key === 'Escape') {
                committed = true;
                nameEl.textContent = oldName;
                input.remove();
            }
        });
    }

    private getVisibleEntityOrder(): number[] {
        const order: number[] = [];
        const wm = this.ctx.engine?.globalContext.worldManager;
        if (!wm) return order;
        for (const scene of wm.getLoadedScenes()) {
            if (this.collapsedScenes.has(scene.id)) continue;
            for (const entity of scene.getRootEntities()) {
                this.collectEntityOrder(entity, order);
            }
        }
        return order;
    }

    private collectEntityOrder(entity: Entity, order: number[]): void {
        if (this.searchTerm && !this.entityMatchesSearch(entity)) return;
        order.push(entity.id);
        if (!this.ctx.state.collapsedEntities.has(entity.id)) {
            for (const child of entity.children) {
                this.collectEntityOrder(child, order);
            }
        }
    }

    private showMultiEntityContextMenu(x: number, y: number): void {
        const selectedIds = [...this.ctx.state.selectedEntityIds];
        const count = selectedIds.length;
        showContextMenu(x, y, [
            {
                label: `Duplicate ${count} Entities`,
                shortcut: 'Ctrl+D',
                action: () => {
                    const scene = this.ctx.getActiveScene();
                    if (!scene) return;
                    const commands: CreateEntityCommand[] = [];
                    for (const id of selectedIds) {
                        const entity = scene.getEntity(id);
                        if (!entity) continue;
                        const data = entity.toJSON();
                        const compData = data.components?.map((c: any) => ({ type: c.type, data: c.data }));
                        commands.push(new CreateEntityCommand(
                            `${entity.name} (copy)`,
                            entity.parent ? entity.parent.id : null,
                            compData,
                        ));
                    }
                    this.ctx.undoManager.execute(new BatchCommand('Duplicate Entities', commands));
                    this.ctx.emit('historyChanged');
                },
            },
            { label: '', separator: true },
            {
                label: `Delete ${count} Entities`,
                shortcut: 'Del',
                danger: true,
                action: () => {
                    const commands = selectedIds.map(id => new DeleteEntityCommand(id));
                    this.ctx.undoManager.execute(new BatchCommand('Delete Entities', commands));
                    this.ctx.emit('historyChanged');
                },
            },
        ]);
    }

    private showEntityContextMenu(entity: Entity, x: number, y: number): void {
        showContextMenu(x, y, [
            {
                label: t('hierarchy.rename'),
                shortcut: 'Double-click',
                action: () => {
                    const nameEl = this.treeContainer.querySelector(`[data-entity-id="${entity.id}"] .tree-node-name`) as HTMLElement;
                    if (nameEl) this.startRename(entity, nameEl);
                },
            },
            {
                label: 'Duplicate',
                shortcut: 'Ctrl+D',
                action: () => {
                    const data = entity.toJSON();
                    const compData = data.components?.map((c: any) => ({ type: c.type, data: c.data }));
                    const cmd = new CreateEntityCommand(
                        `${entity.name} (copy)`,
                        entity.parent ? entity.parent.id : null,
                        compData,
                    );
                    this.ctx.undoManager.execute(cmd);
                    this.ctx.emit('historyChanged');
                },
            },
            {
                label: t('hierarchy.createChild'),
                action: () => {
                    const cmd = new CreateEntityCommand('New Entity', entity.id);
                    this.ctx.undoManager.execute(cmd);
                    this.ctx.emit('historyChanged');
                    this.ctx.state.collapsedEntities.delete(entity.id);
                },
            },
            { label: '', separator: true },
            ...(!DeleteEntityCommand.PROTECTED_NAMES.has(entity.name) ? [{
                label: 'Delete',
                shortcut: 'Del',
                danger: true,
                action: () => {
                    const cmd = new DeleteEntityCommand(entity.id);
                    this.ctx.undoManager.execute(cmd);
                    this.ctx.emit('historyChanged');
                },
            }] : [{
                label: t('hierarchy.deleteLocked'),
                disabled: true,
                action: () => {},
            }]),
        ]);
    }

    private showAddDropdown(anchor: HTMLElement): void {
        this.closeAddDropdown();

        const dropdown = document.createElement('div');
        dropdown.className = 'hierarchy-add-dropdown';

        // New Scene
        const newSceneItem = document.createElement('div');
        newSceneItem.className = 'hierarchy-add-item';
        const newSceneIconSpan = document.createElement('span');
        newSceneIconSpan.style.display = 'flex';
        newSceneIconSpan.style.alignItems = 'center';
        newSceneIconSpan.appendChild(icon(Globe, 14));
        newSceneItem.appendChild(newSceneIconSpan);
        const newSceneLabel = document.createElement('span');
        newSceneLabel.textContent = t('hierarchy.newScene');
        newSceneItem.appendChild(newSceneLabel);
        newSceneItem.addEventListener('click', () => {
            const wm = this.ctx.engine?.globalContext.worldManager;
            if (wm) {
                const scene = wm.createEmptyScene('New Scene');
                addDefaultSceneEntities(scene);
                wm.setActiveScene(scene.id);
                this.ctx.engine!.setActiveScene(scene as any);
                this.ctx.ensurePrimitiveMeshes();
                const sceneKey = this.ctx.getSceneKey(scene);
                if (!this.ctx.state.projectData) this.ctx.state.projectData = {};
                if (!this.ctx.state.projectData.scenes) this.ctx.state.projectData.scenes = {};
                this.ctx.state.projectData.scenes[sceneKey] = scene.toJSON();
                this.ctx.markDirty();
                this.ctx.emit('sceneChanged');
            }
            this.closeAddDropdown();
        });
        dropdown.appendChild(newSceneItem);

        const sceneSep = document.createElement('div');
        sceneSep.className = 'hierarchy-add-separator';
        dropdown.appendChild(sceneSep);

        const entities: { label: string; iconDef: any; name: string; components?: { type: string; data?: any }[] }[] = [
            { label: 'Empty Entity', iconDef: Layers, name: 'Entity' },
            { label: '', iconDef: null, name: '' },
            { label: 'Cube', iconDef: Box, name: 'Cube', components: [
                { type: 'TransformComponent', data: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'MeshRendererComponent', data: { meshType: 'cube' } },
                { type: 'RigidbodyComponent', data: { bodyType: 'static', mass: 1, freezeRotation: false } },
                { type: 'ColliderComponent', data: { shapeType: 'box', size: { x: 1, y: 1, z: 1 } } },
            ] },
            { label: 'Sphere', iconDef: Circle, name: 'Sphere', components: [
                { type: 'TransformComponent', data: { position: { x: 0, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'MeshRendererComponent', data: { meshType: 'sphere' } },
                { type: 'RigidbodyComponent', data: { bodyType: 'static', mass: 1, freezeRotation: false } },
                { type: 'ColliderComponent', data: { shapeType: 'sphere', size: { x: 1, y: 1, z: 1 } } },
            ] },
            { label: 'Plane', iconDef: Square, name: 'Plane', components: [
                { type: 'TransformComponent', data: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 5, y: 1, z: 5 } } },
                { type: 'MeshRendererComponent', data: { meshType: 'plane' } },
                { type: 'RigidbodyComponent', data: { bodyType: 'static', mass: 1, freezeRotation: false } },
                { type: 'ColliderComponent', data: { shapeType: 'box', size: { x: 1, y: 1, z: 1 } } },
            ] },
            { label: '', iconDef: null, name: '' },
            { label: 'Directional Light', iconDef: Sun, name: 'Directional Light', components: [
                { type: 'TransformComponent', data: { position: { x: 0, y: 10, z: 0 }, rotation: { x: -0.3, y: 0.5, z: 0, w: 0.85 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'LightComponent', data: { lightType: 0, color: { r: 1, g: 0.95, b: 0.9, a: 1 }, intensity: 5.0 } },
            ] },
            { label: 'Point Light', iconDef: Lightbulb, name: 'Point Light', components: [
                { type: 'TransformComponent', data: { position: { x: 0, y: 3, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'LightComponent', data: { lightType: 1, color: { r: 1, g: 1, b: 1, a: 1 }, intensity: 10.0, range: 10 } },
            ] },
            { label: 'Spot Light', iconDef: Lightbulb, name: 'Spot Light', components: [
                { type: 'TransformComponent', data: { position: { x: 0, y: 5, z: 0 }, rotation: { x: -0.7071, y: 0, z: 0, w: 0.7071 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'LightComponent', data: { lightType: 2, color: { r: 1, g: 1, b: 1, a: 1 }, intensity: 10.0, range: 15, innerConeAngle: 0.3, outerConeAngle: 0.5 } },
            ] },
            { label: '', iconDef: null, name: '' },
            { label: 'Camera', iconDef: Camera, name: 'Camera', components: [
                { type: 'TransformComponent', data: { position: { x: 0, y: 2, z: 10 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } } },
                { type: 'CameraComponent', data: { fov: 60, near: 0.1, far: 1000 } },
            ] },
        ];

        for (const entry of entities) {
            if (!entry.label) {
                const sep = document.createElement('div');
                sep.className = 'hierarchy-add-separator';
                dropdown.appendChild(sep);
                continue;
            }

            const item = document.createElement('div');
            item.className = 'hierarchy-add-item';
            const iconSpan = document.createElement('span');
            iconSpan.style.display = 'flex';
            iconSpan.style.alignItems = 'center';
            iconSpan.appendChild(icon(entry.iconDef, 14));
            item.appendChild(iconSpan);
            const labelSpan = document.createElement('span');
            labelSpan.textContent = entry.label;
            item.appendChild(labelSpan);
            item.addEventListener('click', () => {
                const cmd = new CreateEntityCommand(entry.name, null, entry.components);
                this.ctx.undoManager.execute(cmd);
                this.ctx.emit('historyChanged');
                this.closeAddDropdown();
            });
            dropdown.appendChild(item);
        }

        const rect = anchor.getBoundingClientRect();
        dropdown.style.position = 'absolute';
        dropdown.style.left = `${rect.left}px`;
        dropdown.style.top = `${rect.bottom + 2}px`;

        document.body.appendChild(dropdown);
        this.addDropdown = dropdown;

        setTimeout(() => {
            const close = (e: MouseEvent) => {
                if (!dropdown.contains(e.target as Node)) {
                    this.closeAddDropdown();
                    window.removeEventListener('mousedown', close);
                }
            };
            window.addEventListener('mousedown', close);
        }, 0);
    }

    private closeAddDropdown(): void {
        if (this.addDropdown) {
            this.addDropdown.remove();
            this.addDropdown = null;
        }
    }

    private refreshActiveStates(): void {
        const scene = this.ctx.getActiveScene();
        if (!scene) return;
        const rows = this.treeContainer.querySelectorAll('.tree-node[data-entity-id]');
        rows.forEach(row => {
            const id = parseInt((row as HTMLElement).dataset.entityId ?? '-1');
            const entity = scene.getEntity(id);
            if (!entity) return;
            const nameEl = row.querySelector('.tree-node-name') as HTMLElement;
            if (!nameEl) return;
            let effectivelyInactive = !entity.active;
            if (!effectivelyInactive) {
                let cur = entity.parent;
                while (cur) { if (!cur.active) { effectivelyInactive = true; break; } cur = cur.parent; }
            }
            nameEl.classList.toggle('inactive', effectivelyInactive);
        });
    }
}
