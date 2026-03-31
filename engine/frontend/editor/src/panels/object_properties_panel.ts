import { EditorContext } from '../editor_context.js';
import { Entity } from '../../../runtime/function/framework/entity.js';
import { ComponentEditor } from './component_editor.js';
import { MultiComponentEditor } from './multi_component_editor.js';
import { showContextMenu } from '../widgets/context_menu.js';
import {
    AddComponentCommand,
    RemoveComponentCommand,
    RenameEntityCommand,
    SetEntityActiveCommand,
    SetComponentEnabledCommand,
    AddTagCommand,
    RemoveTagCommand,
    ResetComponentCommand,
    PasteComponentCommand,
    BatchCommand,
    ChangeEnvironmentPropertyCommand,
} from '../history/commands.js';
import { getRegisteredComponentTypes } from '../../../runtime/function/framework/component_registry.js';
import { NumberField } from '../widgets/fields/number_field.js';
import { BooleanField } from '../widgets/fields/boolean_field.js';
import { ColorField } from '../widgets/fields/color_field.js';
import { Vec3Field } from '../widgets/fields/vec3_field.js';
import { EnumField } from '../widgets/fields/enum_field.js';
import { icon, Globe } from '../widgets/icons.js';

/**
 * Object properties panel: shows selected entity name, tags, components,
 * and an "Add Component" button.
 */
export class ObjectPropertiesPanel {
    readonly el: HTMLElement;
    private ctx: EditorContext;
    private contentEl: HTMLElement;
    private collapsedComponents: Set<string> = new Set();

    constructor() {
        this.ctx = EditorContext.instance;
        this.el = document.createElement('div');
        this.el.className = 'panel properties-panel';
        this.el.style.flex = '1';

        const header = document.createElement('div');
        header.className = 'panel-header';
        const title = document.createElement('span');
        title.className = 'panel-title';
        title.textContent = 'Properties';
        header.appendChild(title);
        this.el.appendChild(header);

        this.contentEl = document.createElement('div');
        this.contentEl.className = 'properties-content';
        this.el.appendChild(this.contentEl);

        this.ctx.on('selectionChanged', () => {
            if (this.ctx.state.terrainSculptActive) {
                const selected = this.ctx.getSelectedEntities();
                const hasTerrain = selected.length === 1 && selected[0].hasComponent('TerrainComponent');
                if (!hasTerrain) {
                    this.ctx.state.terrainSculptActive = false;
                    this.ctx.emit('terrainSculptChanged', false);
                }
            }
            this.render();
        });
        this.ctx.on('componentAdded', () => this.render());
        this.ctx.on('componentRemoved', () => this.render());
        this.ctx.on('propertyChanged', () => this.render());
        this.ctx.on('entityRenamed', () => this.render());
        this.ctx.on('sceneChanged', () => this.render());

        this.render();
    }

    render(): void {
        this.contentEl.innerHTML = '';

        const selected = this.ctx.getSelectedEntities();
        if (selected.length === 0 && this.ctx.state.selectedSceneId !== null) {
            this.renderSceneProperties();
            return;
        }

        if (selected.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'panel-empty';
            empty.textContent = 'No entity selected';
            this.contentEl.appendChild(empty);
            return;
        }

        if (selected.length > 1) {
            this.renderMultiHeader(selected);
            this.renderMultiComponents(selected);
            this.renderMultiAddComponentButton(selected);
            return;
        }

        const entity = selected[0];
        this.renderEntityHeader(entity);
        this.renderComponents(entity);
        this.renderAddComponentButton(entity);
    }

    // ── Multi-entity editing ────────────────────────────────────────

    private renderMultiHeader(entities: Entity[]): void {
        const header = document.createElement('div');
        header.className = 'entity-header';

        const nameRow = document.createElement('div');
        nameRow.className = 'entity-header-row';

        const label = document.createElement('div');
        label.className = 'entity-name-input';
        label.style.background = 'transparent';
        label.style.border = 'none';
        label.style.color = 'var(--text-secondary, #aaa)';
        label.textContent = `${entities.length} entities selected`;
        nameRow.appendChild(label);

        const allActive = entities.every(e => e.active);
        const allInactive = entities.every(e => !e.active);
        const activeToggle = document.createElement('label');
        activeToggle.className = 'entity-active-toggle';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = allActive;
        checkbox.indeterminate = !allActive && !allInactive;
        checkbox.addEventListener('change', () => {
            const newActive = checkbox.checked;
            const commands = entities
                .filter(e => e.active !== newActive)
                .map(e => new SetEntityActiveCommand(e.id, e.active, newActive));
            if (commands.length > 0) {
                this.ctx.undoManager.execute(new BatchCommand('Toggle Active', commands));
                this.ctx.emit('historyChanged');
            }
        });
        activeToggle.appendChild(checkbox);
        activeToggle.appendChild(document.createTextNode(' Active'));
        nameRow.appendChild(activeToggle);

        header.appendChild(nameRow);
        this.contentEl.appendChild(header);
    }

    private renderMultiComponents(entities: Entity[]): void {
        const first = entities[0];
        const firstTypes = first.getComponentEntries().map(([type]) => type);
        const commonTypes = firstTypes.filter(type => entities.every(e => e.hasComponent(type)));

        for (const typeName of commonTypes) {
            const isCollapsed = this.collapsedComponents.has(typeName);

            const section = document.createElement('div');
            section.className = 'component-section';

            const compHeader = document.createElement('div');
            compHeader.className = 'component-header';

            const arrow = document.createElement('span');
            arrow.className = 'collapse-arrow';
            if (isCollapsed) arrow.classList.add('collapsed');
            arrow.textContent = '\u25BC';
            compHeader.appendChild(arrow);

            const compName = document.createElement('span');
            compName.className = 'component-name';
            compName.textContent = this.formatComponentName(typeName);
            compHeader.appendChild(compName);

            const components = entities.map(e => e.getComponent(typeName)!);
            const allEnabled = components.every(c => c.enabled);
            const allDisabled = components.every(c => !c.enabled);
            const enabledCb = document.createElement('input');
            enabledCb.type = 'checkbox';
            enabledCb.className = 'component-enabled';
            enabledCb.checked = allEnabled;
            enabledCb.indeterminate = !allEnabled && !allDisabled;
            enabledCb.title = 'Enabled';
            enabledCb.addEventListener('click', (e) => e.stopPropagation());
            enabledCb.addEventListener('change', () => {
                const newEnabled = enabledCb.checked;
                const cmds = entities
                    .filter(e => e.getComponent(typeName)!.enabled !== newEnabled)
                    .map(e => new SetComponentEnabledCommand(e.id, typeName, e.getComponent(typeName)!.enabled, newEnabled));
                if (cmds.length > 0) {
                    this.ctx.undoManager.execute(new BatchCommand('Toggle Enabled', cmds));
                    this.ctx.emit('historyChanged');
                }
            });
            compHeader.appendChild(enabledCb);

            const menuBtn = document.createElement('span');
            menuBtn.className = 'component-menu-btn';
            menuBtn.textContent = '\u22EE';
            menuBtn.addEventListener('click', (ev) => {
                ev.stopPropagation();
                showContextMenu(ev.clientX, ev.clientY, [
                    {
                        label: `Remove from ${entities.length} entities`,
                        danger: true,
                        action: () => {
                            const cmds = entities.map(e => new RemoveComponentCommand(e.id, typeName));
                            this.ctx.undoManager.execute(new BatchCommand('Remove Component', cmds));
                            this.ctx.emit('historyChanged');
                        },
                    },
                ]);
            });
            compHeader.appendChild(menuBtn);

            compHeader.addEventListener('click', () => {
                if (this.collapsedComponents.has(typeName)) {
                    this.collapsedComponents.delete(typeName);
                } else {
                    this.collapsedComponents.add(typeName);
                }
                this.render();
            });

            section.appendChild(compHeader);

            if (!isCollapsed) {
                const editor = new MultiComponentEditor(entities, typeName);
                section.appendChild(editor.el);
            }

            this.contentEl.appendChild(section);
        }
    }

    private renderMultiAddComponentButton(entities: Entity[]): void {
        const btn = document.createElement('div');
        btn.className = 'add-component-btn';
        btn.innerHTML = '<span>+</span> <span>Add Component to All</span>';

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showAddComponentDropdown(null, btn, entities);
        });

        this.contentEl.appendChild(btn);
    }

    // ── Single-entity editing ───────────────────────────────────────

    private renderEntityHeader(entity: Entity): void {
        const header = document.createElement('div');
        header.className = 'entity-header';

        const nameRow = document.createElement('div');
        nameRow.className = 'entity-header-row';

        const nameInput = document.createElement('input');
        nameInput.className = 'entity-name-input';
        nameInput.type = 'text';
        nameInput.value = entity.name;
        nameInput.addEventListener('change', () => {
            const newName = nameInput.value.trim() || entity.name;
            if (newName !== entity.name) {
                const cmd = new RenameEntityCommand(entity.id, entity.name, newName);
                this.ctx.undoManager.execute(cmd);
                this.ctx.emit('historyChanged');
            }
        });
        nameRow.appendChild(nameInput);

        const activeToggle = document.createElement('label');
        activeToggle.className = 'entity-active-toggle';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = entity.active;
        checkbox.addEventListener('change', () => {
            const cmd = new SetEntityActiveCommand(entity.id, !checkbox.checked, checkbox.checked);
            this.ctx.undoManager.execute(cmd);
            this.ctx.emit('historyChanged');
        });
        activeToggle.appendChild(checkbox);
        activeToggle.appendChild(document.createTextNode(' Active'));
        nameRow.appendChild(activeToggle);

        header.appendChild(nameRow);

        // Tags
        const tagsRow = document.createElement('div');
        tagsRow.className = 'entity-tags-row';

        for (const tag of entity.tags) {
            const tagEl = document.createElement('span');
            tagEl.className = 'entity-tag';
            tagEl.appendChild(document.createTextNode(tag));

            const removeBtn = document.createElement('span');
            removeBtn.className = 'tag-remove';
            removeBtn.textContent = '\u2715';
            removeBtn.addEventListener('click', () => {
                const cmd = new RemoveTagCommand(entity.id, tag);
                this.ctx.undoManager.execute(cmd);
                this.ctx.emit('historyChanged');
            });
            tagEl.appendChild(removeBtn);
            tagsRow.appendChild(tagEl);
        }

        const addTagBtn = document.createElement('button');
        addTagBtn.className = 'icon-btn';
        addTagBtn.textContent = '+';
        addTagBtn.title = 'Add Tag';
        addTagBtn.style.fontSize = '10px';
        addTagBtn.style.width = '18px';
        addTagBtn.style.height = '18px';
        addTagBtn.addEventListener('click', () => {
            const tag = prompt('Enter tag name:');
            if (tag && tag.trim()) {
                const cmd = new AddTagCommand(entity.id, tag.trim());
                this.ctx.undoManager.execute(cmd);
                this.ctx.emit('historyChanged');
            }
        });
        tagsRow.appendChild(addTagBtn);

        header.appendChild(tagsRow);
        this.contentEl.appendChild(header);
    }

    private renderComponents(entity: Entity): void {
        for (const [typeName, component] of entity.getComponentEntries()) {
            if (typeName === 'ScriptComponent') continue;
            const isCollapsed = this.collapsedComponents.has(typeName);

            const section = document.createElement('div');
            section.className = 'component-section';

            const compHeader = document.createElement('div');
            compHeader.className = 'component-header';

            const arrow = document.createElement('span');
            arrow.className = 'collapse-arrow';
            if (isCollapsed) arrow.classList.add('collapsed');
            arrow.textContent = '\u25BC';
            compHeader.appendChild(arrow);

            const compName = document.createElement('span');
            compName.className = 'component-name';
            compName.textContent = this.formatComponentName(typeName);
            compHeader.appendChild(compName);

            const enabledCb = document.createElement('input');
            enabledCb.type = 'checkbox';
            enabledCb.className = 'component-enabled';
            enabledCb.checked = component.enabled;
            enabledCb.title = 'Enabled';
            enabledCb.addEventListener('click', (e) => e.stopPropagation());
            enabledCb.addEventListener('change', () => {
                const cmd = new SetComponentEnabledCommand(entity.id, typeName, !enabledCb.checked, enabledCb.checked);
                this.ctx.undoManager.execute(cmd);
                this.ctx.emit('historyChanged');
            });
            compHeader.appendChild(enabledCb);

            const menuBtn = document.createElement('span');
            menuBtn.className = 'component-menu-btn';
            menuBtn.textContent = '\u22EE';
            menuBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.showComponentContextMenu(entity, typeName, e.clientX, e.clientY);
            });
            compHeader.appendChild(menuBtn);

            compHeader.addEventListener('click', () => {
                if (this.collapsedComponents.has(typeName)) {
                    this.collapsedComponents.delete(typeName);
                } else {
                    this.collapsedComponents.add(typeName);
                }
                this.render();
            });

            section.appendChild(compHeader);

            if (!isCollapsed) {
                const editor = new ComponentEditor(entity, typeName, component);
                section.appendChild(editor.el);
            }

            this.contentEl.appendChild(section);
        }
    }

    private renderAddComponentButton(entity: Entity): void {
        const btn = document.createElement('div');
        btn.className = 'add-component-btn';
        btn.innerHTML = '<span>+</span> <span>Add Component</span>';

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            this.showAddComponentDropdown(entity, btn);
        });

        this.contentEl.appendChild(btn);
    }

    private showAddComponentDropdown(entity: Entity | null, anchor: HTMLElement, entities?: Entity[]): void {
        const allTypes = getRegisteredComponentTypes();

        const categories: Record<string, string[]> = {
            'Rendering': ['MeshRendererComponent', 'CameraComponent', 'LightComponent'],
            'Physics': ['RigidbodyComponent', 'ColliderComponent', 'VehicleComponent'],
            'Audio': ['AudioSourceComponent', 'AudioListenerComponent'],
            'Animation': ['AnimatorComponent'],
            'Network': ['NetworkIdentityComponent'],
            'Environment': ['TerrainComponent'],
            'Core': ['TransformComponent'],
        };

        const dropdown = document.createElement('div');
        dropdown.className = 'add-component-dropdown';
        dropdown.style.position = 'fixed';
        dropdown.style.zIndex = '10000';

        for (const [category, types] of Object.entries(categories)) {
            const catLabel = document.createElement('div');
            catLabel.className = 'add-component-category';
            catLabel.textContent = category;
            dropdown.appendChild(catLabel);

            for (const type of types) {
                if (!allTypes.includes(type)) continue;

                const item = document.createElement('div');
                item.className = 'add-component-item';

                const hasComponent = entities
                    ? entities.every(e => e.hasComponent(type))
                    : entity!.hasComponent(type);

                if (hasComponent) item.classList.add('disabled');
                item.textContent = this.formatComponentName(type);

                if (!hasComponent) {
                    item.addEventListener('click', () => {
                        if (entities) {
                            const cmds = entities
                                .filter(e => !e.hasComponent(type))
                                .map(e => new AddComponentCommand(e.id, type));
                            if (cmds.length > 0) {
                                this.ctx.undoManager.execute(new BatchCommand('Add Component', cmds));
                                this.ctx.emit('historyChanged');
                            }
                        } else {
                            const cmd = new AddComponentCommand(entity!.id, type);
                            this.ctx.undoManager.execute(cmd);
                            this.ctx.emit('historyChanged');
                        }
                        dropdown.remove();
                    });
                }

                dropdown.appendChild(item);
            }
        }

        document.body.appendChild(dropdown);

        const rect = anchor.getBoundingClientRect();
        const dropdownRect = dropdown.getBoundingClientRect();
        let top = rect.bottom + 2;
        let left = rect.left;
        if (top + dropdownRect.height > window.innerHeight) {
            top = rect.top - dropdownRect.height - 2;
        }
        if (top < 0) top = Math.max(4, window.innerHeight - dropdownRect.height - 4);
        if (left + dropdownRect.width > window.innerWidth) {
            left = window.innerWidth - dropdownRect.width - 4;
        }
        dropdown.style.left = `${left}px`;
        dropdown.style.top = `${top}px`;

        setTimeout(() => {
            const close = (e: MouseEvent) => {
                if (!dropdown.contains(e.target as Node)) {
                    dropdown.remove();
                    window.removeEventListener('mousedown', close);
                }
            };
            window.addEventListener('mousedown', close);
        }, 0);
    }

    private showComponentContextMenu(entity: Entity, componentType: string, x: number, y: number): void {
        showContextMenu(x, y, [
            {
                label: 'Reset',
                action: () => {
                    const cmd = new ResetComponentCommand(entity.id, componentType);
                    this.ctx.undoManager.execute(cmd);
                    this.ctx.emit('historyChanged');
                },
            },
            {
                label: 'Copy Values',
                action: () => {
                    const comp = entity.getComponent(componentType);
                    if (comp) {
                        this.ctx.state.clipboard = { type: 'component', componentType, data: comp.toJSON() };
                    }
                },
            },
            {
                label: 'Paste Values',
                disabled: !(this.ctx.state.clipboard?.type === 'component' && this.ctx.state.clipboard?.componentType === componentType),
                action: () => {
                    if (this.ctx.state.clipboard?.data) {
                        const cmd = new PasteComponentCommand(entity.id, componentType, this.ctx.state.clipboard.data);
                        this.ctx.undoManager.execute(cmd);
                        this.ctx.emit('historyChanged');
                    }
                },
            },
            { label: '', separator: true },
            {
                label: 'Remove Component',
                danger: true,
                action: () => {
                    const cmd = new RemoveComponentCommand(entity.id, componentType);
                    this.ctx.undoManager.execute(cmd);
                    this.ctx.emit('historyChanged');
                },
            },
        ]);
    }

    private formatComponentName(typeName: string): string {
        return typeName.replace(/Component$/, '').replace(/([A-Z])/g, ' $1').trim();
    }

    // ── Scene Environment Properties ────────────────────────────────

    private renderSceneProperties(): void {
        const wm = this.ctx.engine?.globalContext.worldManager;
        if (!wm) return;
        const sceneId = this.ctx.state.selectedSceneId!;
        const scene = wm.getLoadedScenes().find((s: any) => s.id === sceneId);
        if (!scene) return;
        const env = (scene as any).environment;
        if (!env) return;

        const header = document.createElement('div');
        header.className = 'entity-header';
        const nameRow = document.createElement('div');
        nameRow.className = 'entity-header-row';
        const iconEl = document.createElement('span');
        iconEl.style.marginRight = '6px';
        iconEl.appendChild(icon(Globe, 16));
        nameRow.appendChild(iconEl);
        const label = document.createElement('div');
        label.className = 'entity-name-input';
        label.style.background = 'transparent';
        label.style.border = 'none';
        label.style.color = 'var(--text-primary, #ddd)';
        label.style.fontWeight = '600';
        label.textContent = (scene as any).name || 'Untitled Scene';
        nameRow.appendChild(label);
        header.appendChild(nameRow);
        this.contentEl.appendChild(header);

        this.renderEnvSection('Skybox', sceneId, env, [
            { path: 'timeOfDay', label: 'Time of Day', type: 'number', min: 0, max: 24, step: 0.1 },
            { path: 'dayNightCycleSpeed', label: 'Cycle Speed', type: 'number', min: 0, max: 120, step: 0.1 },
        ]);

        this.renderEnvSection('Ambient Light', sceneId, env, [
            { path: 'ambientLight.color', label: 'Color', type: 'color' },
            { path: 'ambientLight.intensity', label: 'Intensity', type: 'number', min: 0, max: 10, step: 0.01 },
        ]);

        this.renderEnvSection('Fog', sceneId, env, [
            { path: 'fog.enabled', label: 'Enabled', type: 'boolean' },
            { path: 'fog.color', label: 'Color', type: 'color' },
            { path: 'fog.near', label: 'Near', type: 'number', min: 0, max: 10000, step: 1 },
            { path: 'fog.far', label: 'Far', type: 'number', min: 0, max: 10000, step: 1 },
        ]);

        this.renderEnvSection('Weather', sceneId, env, [
            { path: 'weather.type', label: 'Type', type: 'enum', options: [
                { value: 'clear', label: 'Clear' },
                { value: 'rain', label: 'Rain' },
                { value: 'snow', label: 'Snow' },
                { value: 'fog', label: 'Fog' },
                { value: 'storm', label: 'Storm' },
            ] },
            { path: 'weather.intensity', label: 'Intensity', type: 'number', min: 0, max: 1, step: 0.01 },
            { path: 'weather.windSpeed', label: 'Wind Speed', type: 'number', min: 0, max: 100, step: 0.1 },
            { path: 'weather.windDirection', label: 'Wind Direction', type: 'vec3' },
        ]);

        this.renderEnvSection('Physics', sceneId, env, [
            { path: 'gravity', label: 'Gravity', type: 'vec3' },
        ]);
    }

    private renderEnvSection(
        title: string,
        sceneId: number,
        env: any,
        fields: { path: string; label: string; type: string; min?: number; max?: number; step?: number; options?: { value: string; label: string }[] }[],
    ): void {
        const sectionKey = `env:${title}`;
        const isCollapsed = this.collapsedComponents.has(sectionKey);

        const section = document.createElement('div');
        section.className = 'component-section';

        const compHeader = document.createElement('div');
        compHeader.className = 'component-header';

        const arrow = document.createElement('span');
        arrow.className = 'collapse-arrow';
        if (isCollapsed) arrow.classList.add('collapsed');
        arrow.textContent = '\u25BC';
        compHeader.appendChild(arrow);

        const compName = document.createElement('span');
        compName.className = 'component-name';
        compName.textContent = title;
        compHeader.appendChild(compName);

        compHeader.addEventListener('click', () => {
            if (this.collapsedComponents.has(sectionKey)) {
                this.collapsedComponents.delete(sectionKey);
            } else {
                this.collapsedComponents.add(sectionKey);
            }
            this.render();
        });

        section.appendChild(compHeader);

        if (!isCollapsed) {
            const body = document.createElement('div');
            body.className = 'component-body';

            for (const field of fields) {
                const row = document.createElement('div');
                row.className = 'property-row';

                const labelEl = document.createElement('label');
                labelEl.className = 'property-label';
                labelEl.textContent = field.label;
                row.appendChild(labelEl);

                const valueContainer = document.createElement('div');
                valueContainer.className = 'property-value';

                const currentValue = this.getEnvValue(env, field.path);

                switch (field.type) {
                    case 'number': {
                        const f = new NumberField({
                            value: currentValue ?? 0,
                            min: field.min, max: field.max, step: field.step ?? 0.1,
                            onFinishChange: (newVal) => {
                                const oldVal = this.getEnvValue(env, field.path);
                                this.ctx.undoManager.execute(new ChangeEnvironmentPropertyCommand(sceneId, field.path, oldVal, newVal));
                                this.ctx.emit('historyChanged');
                            },
                        });
                        valueContainer.appendChild(f.el);
                        break;
                    }
                    case 'boolean': {
                        const f = new BooleanField({
                            value: currentValue ?? false,
                            onChange: (newVal) => {
                                const oldVal = this.getEnvValue(env, field.path);
                                this.ctx.undoManager.execute(new ChangeEnvironmentPropertyCommand(sceneId, field.path, oldVal, newVal));
                                this.ctx.emit('historyChanged');
                            },
                        });
                        valueContainer.appendChild(f.el);
                        break;
                    }
                    case 'color': {
                        const arr = currentValue ?? [1, 1, 1];
                        const f = new ColorField({
                            value: { r: arr[0], g: arr[1], b: arr[2] },
                            onFinishChange: (newVal) => {
                                const newArr = [newVal.r, newVal.g, newVal.b] as [number, number, number];
                                const oldArr = [...(this.getEnvValue(env, field.path) ?? [1, 1, 1])] as [number, number, number];
                                this.ctx.undoManager.execute(new ChangeEnvironmentPropertyCommand(sceneId, field.path, oldArr, newArr));
                                this.ctx.emit('historyChanged');
                            },
                        });
                        valueContainer.appendChild(f.el);
                        break;
                    }
                    case 'vec3': {
                        const arr = currentValue ?? [0, 0, 0];
                        const f = new Vec3Field({
                            value: { x: arr[0], y: arr[1], z: arr[2] },
                            step: field.step ?? 0.1,
                            onFinishChange: (newVal) => {
                                const newArr = [newVal.x, newVal.y, newVal.z] as [number, number, number];
                                const oldArr = [...(this.getEnvValue(env, field.path) ?? [0, 0, 0])] as [number, number, number];
                                this.ctx.undoManager.execute(new ChangeEnvironmentPropertyCommand(sceneId, field.path, oldArr, newArr));
                                this.ctx.emit('historyChanged');
                            },
                        });
                        valueContainer.appendChild(f.el);
                        break;
                    }
                    case 'enum': {
                        const f = new EnumField({
                            value: currentValue ?? '',
                            options: field.options ?? [],
                            onChange: (newVal) => {
                                const oldVal = this.getEnvValue(env, field.path);
                                this.ctx.undoManager.execute(new ChangeEnvironmentPropertyCommand(sceneId, field.path, oldVal, newVal));
                                this.ctx.emit('historyChanged');
                            },
                        });
                        valueContainer.appendChild(f.el);
                        break;
                    }
                }

                row.appendChild(valueContainer);
                body.appendChild(row);
            }

            section.appendChild(body);
        }

        this.contentEl.appendChild(section);
    }

    private getEnvValue(env: any, path: string): any {
        const parts = path.split('.');
        let target = env;
        for (const part of parts) {
            if (target == null) return undefined;
            target = target[part];
        }
        return target;
    }
}
