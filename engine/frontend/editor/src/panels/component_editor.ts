import { Component } from '../../../runtime/function/framework/component.js';
import { Entity } from '../../../runtime/function/framework/entity.js';
import { EditorContext } from '../editor_context.js';
import { ChangePropertyCommand } from '../history/commands.js';
import { parseScriptProperties } from '../../../../shared/scripting/script_property_parser.js';
import { Vec3Field } from '../widgets/fields/vec3_field.js';
import { EulerField } from '../widgets/fields/euler_field.js';
import { NumberField } from '../widgets/fields/number_field.js';
import { BooleanField } from '../widgets/fields/boolean_field.js';
import { StringField } from '../widgets/fields/string_field.js';
import { EnumField } from '../widgets/fields/enum_field.js';
import { ColorField } from '../widgets/fields/color_field.js';
import { AssetField } from '../widgets/fields/asset_field.js';
import { Quat } from '../../../../shared/math/quat.js';

interface FieldDef {
    name: string;
    label: string;
    type: 'number' | 'vec3' | 'euler' | 'boolean' | 'string' | 'enum' | 'color' | 'asset' | 'entity';
    min?: number;
    max?: number;
    step?: number;
    options?: { value: string; label: string }[];
    getOptions?: (component: any) => { value: string; label: string }[];
    assetType?: string;
    visible?: (component: any) => boolean;
}

const COMPONENT_FIELD_DEFS: Record<string, FieldDef[]> = {
    TransformComponent: [
        { name: 'position', label: 'Position', type: 'vec3' },
        { name: 'rotation', label: 'Rotation', type: 'euler' },
        { name: 'scale', label: 'Scale', type: 'vec3', step: 0.1 },
    ],
    MeshRendererComponent: [
        { name: 'meshType', label: 'Mesh', type: 'enum', options: [
            { value: 'cube', label: 'Cube' },
            { value: 'sphere', label: 'Sphere' },
            { value: 'plane', label: 'Plane' },
            { value: 'cylinder', label: 'Cylinder' },
            { value: 'cone', label: 'Cone' },
            { value: 'capsule', label: 'Capsule' },
            { value: 'custom', label: 'Custom' },
        ] },
        { name: 'meshAsset', label: 'Mesh Asset', type: 'asset', assetType: 'mesh' },
        { name: 'textureBundle', label: 'Texture', type: 'asset', assetType: 'texture',
            visible: (c) => c.meshType !== 'custom' },
        { name: 'waterEffect', label: 'Water Effect', type: 'boolean' },
        { name: 'modelRotationX', label: 'Mesh Rotation X', type: 'number', step: 1 },
        { name: 'modelRotationY', label: 'Mesh Rotation Y', type: 'number', step: 1 },
        { name: 'modelRotationZ', label: 'Mesh Rotation Z', type: 'number', step: 1 },
    ],
    CameraComponent: [
        { name: 'fov', label: 'FOV', type: 'number', min: 10, max: 179, step: 1 },
        { name: 'near', label: 'Near', type: 'number', min: 0.01, max: 100, step: 0.01 },
        { name: 'far', label: 'Far', type: 'number', min: 1, max: 10000, step: 1 },
        { name: 'clearColor', label: 'Clear Color', type: 'color' },
    ],
    LightComponent: [
        { name: 'lightType', label: 'Type', type: 'enum', options: [
            { value: '0', label: 'Directional' },
            { value: '1', label: 'Point' },
            { value: '2', label: 'Spot' },
        ] },
        { name: 'color', label: 'Color', type: 'color' },
        { name: 'intensity', label: 'Intensity', type: 'number', min: 0, max: 100, step: 0.1 },
        { name: 'range', label: 'Range', type: 'number', min: 0, max: 1000, step: 0.5, visible: (c) => c.lightType !== 0 },
    ],
    RigidbodyComponent: [
        { name: 'bodyType', label: 'Type', type: 'enum', options: [
            { value: '1', label: 'Dynamic' },
            { value: '2', label: 'Kinematic' },
            { value: '0', label: 'Static' },
        ] },
        { name: 'mass', label: 'Mass', type: 'number', min: 0, max: 10000, step: 0.1 },
        { name: 'linearDamping', label: 'Linear Drag', type: 'number', min: 0, max: 100, step: 0.01 },
        { name: 'angularDamping', label: 'Angular Drag', type: 'number', min: 0, max: 100, step: 0.01 },
        { name: 'useGravity', label: 'Use Gravity', type: 'boolean' },
    ],
    ColliderComponent: [
        { name: 'shapeType', label: 'Shape', type: 'enum', options: [
            { value: '0', label: 'Box' },
            { value: '1', label: 'Sphere' },
            { value: '2', label: 'Capsule' },
            { value: '3', label: 'Mesh' },
            { value: '4', label: 'Terrain' },
        ] },
        { name: 'center', label: 'Center', type: 'vec3' },
        { name: 'size', label: 'Size', type: 'vec3' },
        { name: 'isTrigger', label: 'Is Trigger', type: 'boolean' },
    ],
    AudioSourceComponent: [
        { name: 'audioAsset', label: 'Audio Clip', type: 'asset', assetType: 'audio' },
        { name: 'volume', label: 'Volume', type: 'number', min: 0, max: 1, step: 0.01 },
        { name: 'pitch', label: 'Pitch', type: 'number', min: 0.1, max: 3, step: 0.01 },
        { name: 'loop', label: 'Loop', type: 'boolean' },
        { name: 'playOnStart', label: 'Play on Start', type: 'boolean' },
        { name: 'spatial', label: 'Spatial', type: 'boolean' },
    ],
    AudioListenerComponent: [],
    AnimatorComponent: [
        { name: 'currentClip', label: 'Animation', type: 'enum', getOptions: (c: any) => {
            const names: string[] = c.availableClipNames ?? [];
            const opts = [{ value: '', label: 'None' }];
            for (const n of names) opts.push({ value: n, label: n });
            return opts;
        } },
        { name: 'speed', label: 'Speed', type: 'number', min: 0, max: 10, step: 0.01 },
        { name: 'looping', label: 'Loop', type: 'boolean' },
    ],
    ScriptComponent: [
        { name: 'scriptURL', label: 'Script', type: 'asset', assetType: 'script' },
    ],
    NetworkIdentityComponent: [
        { name: 'isOwner', label: 'Is Owner', type: 'boolean' },
        { name: 'syncPosition', label: 'Sync Position', type: 'boolean' },
        { name: 'syncRotation', label: 'Sync Rotation', type: 'boolean' },
    ],
    TerrainComponent: [
        { name: 'width', label: 'Width', type: 'number', min: 1, max: 2000, step: 1 },
        { name: 'depth', label: 'Depth', type: 'number', min: 1, max: 2000, step: 1 },
        { name: 'resolution', label: 'Resolution', type: 'number', min: 2, max: 256, step: 1 },
        { name: 'heightScale', label: 'Height Scale', type: 'number', min: 0, max: 500, step: 0.5 },
        { name: 'baseColor', label: 'Color', type: 'color' },
        { name: 'roughness', label: 'Roughness', type: 'number', min: 0, max: 1, step: 0.01 },
    ],
    VehicleComponent: [
        { name: 'maxMotorForce', label: 'Motor Force', type: 'number', min: 0, max: 50000, step: 10 },
        { name: 'maxBrakeForce', label: 'Brake Force', type: 'number', min: 0, max: 50000, step: 10 },
        { name: 'maxSteerAngle', label: 'Max Steer Angle', type: 'number', min: 0, max: 90, step: 1 },
        { name: 'suspensionRestLength', label: 'Suspension Rest', type: 'number', min: 0.01, max: 2, step: 0.01 },
        { name: 'suspensionStiffness', label: 'Suspension Stiffness', type: 'number', min: 0, max: 500, step: 1 },
        { name: 'dampingCompression', label: 'Damping Compress', type: 'number', min: 0, max: 10, step: 0.1 },
        { name: 'dampingRelaxation', label: 'Damping Relax', type: 'number', min: 0, max: 10, step: 0.1 },
        { name: 'wheelRadius', label: 'Wheel Radius', type: 'number', min: 0.01, max: 5, step: 0.01 },
    ],
};

/**
 * Generates the property editor UI for a single component on an entity.
 */
export class ComponentEditor {
    readonly el: HTMLElement;

    constructor(entity: Entity, componentType: string, component: Component) {
        const ctx = EditorContext.instance;

        this.el = document.createElement('div');
        this.el.className = 'component-body';

        const fields = COMPONENT_FIELD_DEFS[componentType] ?? [];

        for (const fieldDef of fields) {
            if (fieldDef.visible && !fieldDef.visible(component)) continue;

            const row = document.createElement('div');
            row.className = 'field-row';

            const label = document.createElement('div');
            label.className = 'field-label';
            label.textContent = fieldDef.label;
            label.title = fieldDef.name;
            row.appendChild(label);

            const valueContainer = document.createElement('div');
            valueContainer.className = 'field-value';

            let currentValue = (component as any)[fieldDef.name];
            if (fieldDef.name === 'textureBundle') {
                currentValue = (component as any).materialOverrides?.textureBundle ?? null;
            }

            switch (fieldDef.type) {
                case 'vec3': {
                    const val = currentValue ?? { x: 0, y: 0, z: 0 };
                    const v = typeof val.toJSON === 'function' ? val.toJSON() : val;
                    const field = new Vec3Field({
                        value: v,
                        step: fieldDef.step ?? 0.1,
                        onFinishChange: (newVal) => {
                            const oldVal = typeof (component as any)[fieldDef.name]?.toJSON === 'function'
                                ? (component as any)[fieldDef.name].toJSON()
                                : { ...(component as any)[fieldDef.name] };
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, oldVal, newVal);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'euler': {
                    const val = currentValue ?? { x: 0, y: 0, z: 0 };
                    let euler: { x: number; y: number; z: number };
                    const D2R = Math.PI / 180;
                    if (val && typeof val.toEuler === 'function') {
                        // Quat instance — toEuler returns degrees, EulerField expects radians
                        const e = val.toEuler();
                        euler = { x: (e.x ?? e.data?.[0] ?? 0) * D2R, y: (e.y ?? e.data?.[1] ?? 0) * D2R, z: (e.z ?? e.data?.[2] ?? 0) * D2R };
                    } else if (val.w !== undefined) {
                        // Plain quaternion object — convert to euler radians
                        const q = new Quat(val.x, val.y, val.z, val.w);
                        const e = q.toEuler();
                        euler = { x: e.x * D2R, y: e.y * D2R, z: e.z * D2R };
                    } else {
                        // Assume radians already
                        euler = typeof val.toJSON === 'function' ? val.toJSON() : val;
                    }
                    const field = new EulerField({
                        value: euler,
                        onFinishChange: (newValDeg) => {
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, euler, newValDeg);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'number': {
                    const field = new NumberField({
                        value: currentValue ?? 0,
                        min: fieldDef.min,
                        max: fieldDef.max,
                        step: fieldDef.step ?? 0.1,
                        onFinishChange: (newVal) => {
                            const oldVal = (component as any)[fieldDef.name] ?? 0;
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, oldVal, newVal);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'boolean': {
                    const field = new BooleanField({
                        value: currentValue ?? false,
                        onChange: (newVal) => {
                            const oldVal = (component as any)[fieldDef.name] ?? false;
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, oldVal, newVal);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'string': {
                    const field = new StringField({
                        value: currentValue ?? '',
                        onFinishChange: (newVal) => {
                            const oldVal = (component as any)[fieldDef.name] ?? '';
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, oldVal, newVal);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'enum': {
                    const isNumericEnum = typeof currentValue === 'number';
                    let opts = fieldDef.getOptions ? fieldDef.getOptions(component) : (fieldDef.options ?? []);
                    if (componentType === 'ColliderComponent' && fieldDef.name === 'shapeType') {
                        const hasTerrain = !!entity.getComponent('TerrainComponent');
                        if (!hasTerrain) opts = opts.filter(o => o.label !== 'Terrain');
                        const mr = entity.getComponent('MeshRendererComponent') as any;
                        if (!mr?.meshAsset) opts = opts.filter(o => o.label !== 'Mesh');
                    }
                    const field = new EnumField({
                        value: String(currentValue ?? opts[0]?.value ?? ''),
                        options: opts,
                        onChange: (newVal) => {
                            const oldVal = (component as any)[fieldDef.name] ?? '';
                            const converted = isNumericEnum ? Number(newVal) : newVal;
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, oldVal, converted);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'color': {
                    const val = currentValue ?? { r: 1, g: 1, b: 1, a: 1 };
                    let colorObj: { r: number; g: number; b: number; a: number };
                    if (Array.isArray(val)) {
                        colorObj = { r: val[0] ?? 1, g: val[1] ?? 1, b: val[2] ?? 1, a: val[3] ?? 1 };
                    } else if (typeof val.toJSON === 'function') {
                        colorObj = val.toJSON();
                    } else {
                        colorObj = val;
                    }
                    const isArrayColor = Array.isArray(currentValue);
                    const field = new ColorField({
                        value: colorObj,
                        onFinishChange: (newVal) => {
                            const cur = (component as any)[fieldDef.name];
                            let oldVal: any;
                            if (Array.isArray(cur)) oldVal = [...cur];
                            else if (typeof cur?.toJSON === 'function') oldVal = cur.toJSON();
                            else oldVal = { ...cur };
                            const finalVal = isArrayColor ? [newVal.r, newVal.g, newVal.b, newVal.a] : newVal;
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, oldVal, finalVal);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'asset': {
                    const field = new AssetField({
                        value: currentValue ?? null,
                        assetType: fieldDef.assetType,
                        onChange: (newVal) => {
                            const oldVal = (component as any)[fieldDef.name] ?? null;
                            const cmd = new ChangePropertyCommand(entity.id, componentType, fieldDef.name, oldVal, newVal);
                            ctx.undoManager.execute(cmd);
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }
            }

            row.appendChild(valueContainer);
            this.el.appendChild(row);
        }

        // Script properties
        if (componentType === 'ScriptComponent') {
            this.renderScriptProperties(entity, component, ctx);

            const sc = component as any;
            const pd = ctx.state.projectData;
            if (pd && pd.scripts) {
                const entityName = entity.name || '';
                const hasFSM = Object.keys(pd.scripts).some(k =>
                    k.includes('fsm_driver') && k.includes(entityName.replace(/\//g, '_'))
                );
                if (hasFSM) {
                    const fsmBtn = document.createElement('button');
                    fsmBtn.textContent = 'View FSMs';
                    fsmBtn.title = "Switch to FSM tab and show this entity's state machines";
                    fsmBtn.style.cssText = 'margin:8px 0;padding:4px 12px;border:1px solid rgba(139,92,246,0.4);border-radius:4px;background:rgba(139,92,246,0.15);color:#c4b5fd;cursor:pointer;font-size:11px;width:100%;';
                    fsmBtn.addEventListener('click', () => {
                        ctx.emit('showEntityFSM', { entityName });
                    });
                    this.el.appendChild(fsmBtn);
                }
            }
        }

        // Terrain sculpt controls
        if (componentType === 'TerrainComponent') {
            this.el.appendChild(this.buildTerrainSculptUI(entity, ctx));
        }

        // Fallback: raw JSON for components with no field definitions
        if (fields.length === 0) {
            const raw = document.createElement('pre');
            raw.style.fontSize = 'var(--font-size-xs)';
            raw.style.color = 'var(--text-disabled)';
            raw.style.padding = 'var(--spacing-sm)';
            raw.style.whiteSpace = 'pre-wrap';
            raw.style.wordBreak = 'break-all';
            try {
                raw.textContent = JSON.stringify(component.toJSON(), null, 2);
            } catch {
                raw.textContent = '(no data)';
            }
            this.el.appendChild(raw);
        }
    }

    private buildTerrainSculptUI(entity: Entity, ctx: EditorContext): HTMLElement {
        const container = document.createElement('div');
        container.className = 'terrain-sculpt-section';
        container.style.padding = '6px 8px';
        container.style.borderTop = '1px solid var(--border-color, #333)';
        container.style.marginTop = '4px';

        const isActive = ctx.state.terrainSculptActive;
        const brush = ctx.state.terrainSculptBrush;

        const toggleBtn = document.createElement('button');
        toggleBtn.className = 'terrain-sculpt-btn';
        toggleBtn.textContent = isActive ? 'Stop Sculpting' : 'Sculpt Terrain';
        toggleBtn.style.cssText = `
            width: 100%; padding: 6px 0; border: none; border-radius: 4px; cursor: pointer;
            font-size: 12px; font-weight: 500;
            background: ${isActive ? '#e74c3c' : '#3498db'}; color: white;
        `;
        toggleBtn.addEventListener('click', () => {
            ctx.state.terrainSculptActive = !ctx.state.terrainSculptActive;
            if (ctx.state.terrainSculptActive) {
                ctx.setSelection([entity.id]);
            }
            ctx.emit('terrainSculptChanged', ctx.state.terrainSculptActive);
            ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'TerrainComponent', field: '_sculpt' });
        });
        container.appendChild(toggleBtn);

        if (isActive) {
            // Brush mode
            const modeRow = document.createElement('div');
            modeRow.className = 'field-row';
            modeRow.style.marginTop = '6px';
            const modeLabel = document.createElement('div');
            modeLabel.className = 'field-label';
            modeLabel.textContent = 'Brush';
            modeRow.appendChild(modeLabel);

            const modeContainer = document.createElement('div');
            modeContainer.className = 'field-value';
            modeContainer.style.display = 'flex';
            modeContainer.style.gap = '2px';
            const modes: Array<{ value: 'raise' | 'lower' | 'smooth' | 'flatten'; label: string }> = [
                { value: 'raise', label: 'Raise' },
                { value: 'lower', label: 'Lower' },
                { value: 'smooth', label: 'Smooth' },
                { value: 'flatten', label: 'Flatten' },
            ];
            for (const m of modes) {
                const btn = document.createElement('button');
                btn.textContent = m.label;
                btn.style.cssText = `
                    flex: 1; padding: 3px 0; border: 1px solid #555; border-radius: 3px; cursor: pointer;
                    font-size: 10px; color: white;
                    background: ${brush.mode === m.value ? '#3498db' : '#2c2c2c'};
                `;
                btn.addEventListener('click', () => {
                    ctx.state.terrainSculptBrush.mode = m.value;
                    ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'TerrainComponent', field: '_sculpt' });
                });
                modeContainer.appendChild(btn);
            }
            modeRow.appendChild(modeContainer);
            container.appendChild(modeRow);

            // Radius
            container.appendChild(this.buildBrushSliderRow(entity, ctx, 'Radius', brush.radius, 0.5, 50, 0.5,
                (v) => { ctx.state.terrainSculptBrush.radius = v; }));

            // Strength
            container.appendChild(this.buildBrushSliderRow(entity, ctx, 'Strength', brush.strength, 0.001, 0.2, 0.001,
                (v) => { ctx.state.terrainSculptBrush.strength = v; }));
        }

        return container;
    }

    private buildBrushSliderRow(
        entity: Entity, ctx: EditorContext,
        label: string, value: number, min: number, max: number, step: number,
        setter: (v: number) => void,
    ): HTMLElement {
        const row = document.createElement('div');
        row.className = 'field-row';
        const labelEl = document.createElement('div');
        labelEl.className = 'field-label';
        labelEl.textContent = label;
        row.appendChild(labelEl);

        const field = new NumberField({
            value, min, max, step,
            onFinishChange: (v) => {
                setter(v);
                ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'TerrainComponent', field: '_sculpt' });
            },
        });

        const valContainer = document.createElement('div');
        valContainer.className = 'field-value';
        valContainer.style.display = 'flex';
        valContainer.style.gap = '2px';
        valContainer.style.alignItems = 'center';

        const minusBtn = document.createElement('button');
        minusBtn.textContent = '\u2212';
        minusBtn.title = `Decrease ${label.toLowerCase()}`;
        minusBtn.style.cssText = 'width:22px;height:22px;border:1px solid #555;border-radius:3px;background:#2c2c2c;color:white;cursor:pointer;font-size:14px;line-height:1;padding:0;';
        minusBtn.addEventListener('click', () => {
            setter(Math.max(min, value - (step < 0.01 ? 0.01 : 1)));
            ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'TerrainComponent', field: '_sculpt' });
        });
        valContainer.appendChild(minusBtn);

        field.el.style.flex = '1';
        valContainer.appendChild(field.el);

        const plusBtn = document.createElement('button');
        plusBtn.textContent = '+';
        plusBtn.title = `Increase ${label.toLowerCase()}`;
        plusBtn.style.cssText = minusBtn.style.cssText;
        plusBtn.addEventListener('click', () => {
            setter(Math.min(max, value + (step < 0.01 ? 0.01 : 1)));
            ctx.emit('propertyChanged', { entityId: entity.id, componentType: 'TerrainComponent', field: '_sculpt' });
        });
        valContainer.appendChild(plusBtn);

        row.appendChild(valContainer);
        return row;
    }

    private renderScriptProperties(entity: Entity, component: Component, ctx: EditorContext): void {
        const sc = component as any;
        const scriptURL = sc.scriptURL;
        if (!scriptURL) return;

        const pd = ctx.state.projectData;
        const source = pd?.scripts?.[scriptURL];
        if (!source) return;

        const propDefs = parseScriptProperties(source);
        if (propDefs.length === 0) return;

        if (!sc.properties) sc.properties = {};

        const header = document.createElement('div');
        header.className = 'field-section-header';
        header.textContent = 'Properties';
        header.style.marginTop = '8px';
        header.style.marginBottom = '4px';
        header.style.fontSize = 'var(--font-size-xs)';
        header.style.color = 'var(--text-secondary)';
        header.style.textTransform = 'uppercase';
        header.style.letterSpacing = '0.5px';
        this.el.appendChild(header);

        for (const propDef of propDefs) {
            const row = document.createElement('div');
            row.className = 'field-row';

            const label = document.createElement('div');
            label.className = 'field-label';
            label.textContent = this.formatPropertyLabel(propDef.name);
            label.title = `${propDef.name}: ${propDef.type} (default: ${JSON.stringify(propDef.default)})`;
            row.appendChild(label);

            const valueContainer = document.createElement('div');
            valueContainer.className = 'field-value';

            const currentValue = sc.properties[propDef.name] ?? propDef.default;

            const onPropChange = (newVal: any) => {
                sc.properties[propDef.name] = newVal;
                if (sc.markDirty) sc.markDirty();
                ctx.emit('historyChanged');
            };

            switch (propDef.type) {
                case 'number': {
                    const field = new NumberField({ value: currentValue ?? 0, step: 0.1, onFinishChange: onPropChange });
                    valueContainer.appendChild(field.el);
                    break;
                }
                case 'string': {
                    const field = new StringField({ value: currentValue ?? '', onFinishChange: onPropChange });
                    valueContainer.appendChild(field.el);
                    break;
                }
                case 'boolean': {
                    const field = new BooleanField({ value: currentValue ?? false, onChange: onPropChange });
                    valueContainer.appendChild(field.el);
                    break;
                }
                case 'color': {
                    const val = currentValue ?? [1, 1, 1, 1];
                    const colorObj = Array.isArray(val)
                        ? { r: val[0] ?? 1, g: val[1] ?? 1, b: val[2] ?? 1, a: val[3] ?? 1 }
                        : val;
                    const field = new ColorField({
                        value: colorObj,
                        onFinishChange: (newVal) => onPropChange([newVal.r, newVal.g, newVal.b, newVal.a]),
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }
                case 'asset': {
                    const field = new AssetField({ value: currentValue ?? null, assetType: 'model', onChange: onPropChange });
                    valueContainer.appendChild(field.el);
                    break;
                }
                case 'entity': {
                    const refContainer = document.createElement('div');
                    refContainer.style.cssText = 'display:flex;flex-direction:column;gap:4px;width:100%;';

                    const entitySelect = document.createElement('select');
                    entitySelect.className = 'field-select';
                    entitySelect.style.cssText = 'width:100%;padding:3px 4px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;font-size:var(--font-size-sm);';

                    const noneOpt = document.createElement('option');
                    noneOpt.value = '';
                    noneOpt.textContent = '(None)';
                    entitySelect.appendChild(noneOpt);

                    const currentRefId = currentValue?.__entityRef ?? currentValue?.__componentRef ?? null;
                    const currentCompType = currentValue?.type ?? null;

                    const scene = ctx.getActiveScene();
                    const allEntities: any[] = [];
                    if (scene) {
                        const entities = (scene as any).getAllEntities?.() ?? scene.entities ?? [];
                        for (const e of entities) {
                            if (e.id === entity.id) continue;
                            allEntities.push(e);
                            const opt = document.createElement('option');
                            opt.value = String(e.id);
                            opt.textContent = e.name;
                            if (currentRefId === e.id) opt.selected = true;
                            entitySelect.appendChild(opt);
                        }
                    }
                    refContainer.appendChild(entitySelect);

                    const compSelect = document.createElement('select');
                    compSelect.className = 'field-select';
                    compSelect.style.cssText = 'width:100%;padding:3px 4px;background:var(--bg-secondary);color:var(--text-primary);border:1px solid var(--border-color);border-radius:3px;font-size:var(--font-size-sm);font-style:italic;';

                    const populateComponents = (entityId: number) => {
                        compSelect.innerHTML = '';
                        const goOpt = document.createElement('option');
                        goOpt.value = '';
                        goOpt.textContent = '(Entity)';
                        compSelect.appendChild(goOpt);

                        const refEntity = allEntities.find(e => e.id === entityId);
                        if (refEntity) {
                            const comps = refEntity.getComponents?.() ?? [];
                            for (const c of comps) {
                                const typeName = c.constructor?.name ?? c.type ?? '';
                                if (!typeName || typeName === 'TransformComponent') continue;
                                const opt = document.createElement('option');
                                opt.value = typeName;
                                opt.textContent = typeName.replace('Component', '');
                                if (currentCompType === typeName) opt.selected = true;
                                compSelect.appendChild(opt);
                            }
                        }
                    };

                    if (currentRefId) populateComponents(currentRefId);
                    refContainer.appendChild(compSelect);

                    const emitChange = () => {
                        const eid = parseInt(entitySelect.value);
                        if (!eid || isNaN(eid)) { onPropChange(null); return; }
                        const compType = compSelect.value;
                        if (compType) {
                            onPropChange({ __componentRef: eid, type: compType });
                        } else {
                            onPropChange({ __entityRef: eid });
                        }
                    };

                    entitySelect.addEventListener('change', () => {
                        const eid = parseInt(entitySelect.value);
                        if (eid && !isNaN(eid)) populateComponents(eid);
                        else compSelect.innerHTML = '';
                        emitChange();
                    });
                    compSelect.addEventListener('change', emitChange);

                    valueContainer.appendChild(refContainer);
                    break;
                }
                default: {
                    const field = new StringField({ value: String(currentValue ?? ''), onFinishChange: onPropChange });
                    valueContainer.appendChild(field.el);
                    break;
                }
            }

            row.appendChild(valueContainer);
            this.el.appendChild(row);
        }
    }

    private formatPropertyLabel(name: string): string {
        return name
            .replace(/([A-Z])/g, ' $1')
            .replace(/^./, c => c.toUpperCase())
            .trim();
    }
}

export function getComponentFieldDefs(): Record<string, FieldDef[]> {
    return COMPONENT_FIELD_DEFS;
}
