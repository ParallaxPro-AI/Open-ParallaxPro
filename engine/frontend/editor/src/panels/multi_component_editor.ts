import { Entity } from '../../../runtime/function/framework/entity.js';
import { EditorContext } from '../editor_context.js';
import { ChangePropertyCommand, BatchCommand } from '../history/commands.js';
import { Vec3Field } from '../widgets/fields/vec3_field.js';
import { EulerField } from '../widgets/fields/euler_field.js';
import { NumberField } from '../widgets/fields/number_field.js';
import { BooleanField } from '../widgets/fields/boolean_field.js';
import { StringField } from '../widgets/fields/string_field.js';
import { EnumField } from '../widgets/fields/enum_field.js';
import { ColorField } from '../widgets/fields/color_field.js';
import { AssetField } from '../widgets/fields/asset_field.js';
import { getComponentFieldDefs } from './component_editor.js';

/**
 * Multi-entity component editor: shows fields for a component type shared
 * by multiple entities. Displays common values or "Mixed" indicators, and
 * applies changes to all entities at once via BatchCommand.
 */
export class MultiComponentEditor {
    readonly el: HTMLElement;

    constructor(entities: Entity[], componentType: string) {
        const ctx = EditorContext.instance;
        const fieldDefs = getComponentFieldDefs()[componentType] ?? [];

        this.el = document.createElement('div');
        this.el.className = 'component-body';

        const components = entities.map(e => e.getComponent(componentType)!);

        for (const fieldDef of fieldDefs) {
            if (fieldDef.visible && !components.every(c => fieldDef.visible!(c))) continue;

            const row = document.createElement('div');
            row.className = 'field-row';

            const label = document.createElement('div');
            label.className = 'field-label';
            label.textContent = fieldDef.label;
            label.title = fieldDef.name;
            row.appendChild(label);

            const valueContainer = document.createElement('div');
            valueContainer.className = 'field-value';

            const values = components.map(c => (c as any)[fieldDef.name]);

            switch (fieldDef.type) {
                case 'vec3': {
                    const first = values[0] ?? { x: 0, y: 0, z: 0 };
                    const v = typeof first.toJSON === 'function' ? first.toJSON() : { ...first };
                    const allSame = values.every(val => {
                        const vv = val ? (typeof val.toJSON === 'function' ? val.toJSON() : val) : { x: 0, y: 0, z: 0 };
                        return Math.abs(vv.x - v.x) < 0.001 && Math.abs(vv.y - v.y) < 0.001 && Math.abs(vv.z - v.z) < 0.001;
                    });

                    if (allSame) {
                        const field = new Vec3Field({
                            value: v,
                            step: fieldDef.step ?? 0.1,
                            onFinishChange: (newVal) => {
                                const cmds = entities.map((ent, i) => {
                                    const comp = components[i];
                                    const old = typeof (comp as any)[fieldDef.name]?.toJSON === 'function'
                                        ? (comp as any)[fieldDef.name].toJSON()
                                        : { ...(comp as any)[fieldDef.name] };
                                    return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, old, newVal);
                                });
                                ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
                                ctx.emit('historyChanged');
                            },
                        });
                        valueContainer.appendChild(field.el);
                    } else {
                        this.appendMixedLabel(valueContainer);
                    }
                    break;
                }

                case 'euler': {
                    const getEuler = (val: any) => {
                        if (!val) return { x: 0, y: 0, z: 0 };
                        if (typeof val.toEuler === 'function') {
                            const e = val.toEuler();
                            return { x: e.x ?? 0, y: e.y ?? 0, z: e.z ?? 0 };
                        }
                        if (val.w !== undefined) return { x: 0, y: 0, z: 0 };
                        return typeof val.toJSON === 'function' ? val.toJSON() : { ...val };
                    };
                    const firstEuler = getEuler(values[0]);
                    const allSame = values.every(val => {
                        const e = getEuler(val);
                        return Math.abs(e.x - firstEuler.x) < 0.1 && Math.abs(e.y - firstEuler.y) < 0.1 && Math.abs(e.z - firstEuler.z) < 0.1;
                    });

                    if (allSame) {
                        const field = new EulerField({
                            value: firstEuler,
                            onFinishChange: (newValDeg) => {
                                const cmds = entities.map((ent, i) => {
                                    const euler = getEuler((components[i] as any)[fieldDef.name]);
                                    return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, euler, newValDeg);
                                });
                                ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
                                ctx.emit('historyChanged');
                            },
                        });
                        valueContainer.appendChild(field.el);
                    } else {
                        this.appendMixedLabel(valueContainer);
                    }
                    break;
                }

                case 'number': {
                    const firstVal = values[0] ?? 0;
                    const allSame = values.every(v => Math.abs((v ?? 0) - firstVal) < 0.0001);

                    const field = new NumberField({
                        value: allSame ? firstVal : 0,
                        min: fieldDef.min,
                        max: fieldDef.max,
                        step: fieldDef.step ?? 0.1,
                        onFinishChange: (newVal) => {
                            const cmds = entities.map((ent, i) => {
                                const old = (components[i] as any)[fieldDef.name] ?? 0;
                                return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, old, newVal);
                            });
                            ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
                            ctx.emit('historyChanged');
                        },
                    });
                    if (!allSame) {
                        const input = field.el.querySelector('input');
                        if (input) {
                            (input as HTMLInputElement).value = '';
                            (input as HTMLInputElement).placeholder = '\u2014';
                        }
                    }
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'boolean': {
                    const firstVal = values[0] ?? false;
                    const allSame = values.every(v => (v ?? false) === firstVal);

                    const field = new BooleanField({
                        value: allSame ? firstVal : false,
                        onChange: (newVal) => {
                            const cmds = entities.map((ent, i) => {
                                const old = (components[i] as any)[fieldDef.name] ?? false;
                                return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, old, newVal);
                            });
                            ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
                            ctx.emit('historyChanged');
                        },
                    });
                    if (!allSame) {
                        const cb = field.el.querySelector('input');
                        if (cb) (cb as HTMLInputElement).indeterminate = true;
                    }
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'string': {
                    const firstVal = values[0] ?? '';
                    const allSame = values.every(v => (v ?? '') === firstVal);

                    const field = new StringField({
                        value: allSame ? firstVal : '',
                        onFinishChange: (newVal) => {
                            const cmds = entities.map((ent, i) => {
                                const old = (components[i] as any)[fieldDef.name] ?? '';
                                return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, old, newVal);
                            });
                            ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
                            ctx.emit('historyChanged');
                        },
                    });
                    if (!allSame) {
                        const input = field.el.querySelector('input');
                        if (input) {
                            (input as HTMLInputElement).value = '';
                            (input as HTMLInputElement).placeholder = 'Mixed';
                        }
                    }
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'enum': {
                    const firstVal = String(values[0] ?? '');
                    const allSame = values.every(v => String(v ?? '') === firstVal);
                    const isNumericEnum = typeof values[0] === 'number';

                    const field = new EnumField({
                        value: allSame ? firstVal : '',
                        options: [
                            ...(allSame ? [] : [{ value: '', label: '\u2014 Mixed \u2014' }]),
                            ...(fieldDef.options ?? []),
                        ],
                        onChange: (newVal) => {
                            if (newVal === '') return;
                            const converted = isNumericEnum ? Number(newVal) : newVal;
                            const cmds = entities.map((ent, i) => {
                                const old = (components[i] as any)[fieldDef.name] ?? '';
                                return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, old, converted);
                            });
                            ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'color': {
                    const normalize = (val: any) => {
                        if (!val) return { r: 1, g: 1, b: 1, a: 1 };
                        if (Array.isArray(val)) return { r: val[0] ?? 1, g: val[1] ?? 1, b: val[2] ?? 1, a: val[3] ?? 1 };
                        if (typeof val.toJSON === 'function') return val.toJSON();
                        return val;
                    };
                    const firstColor = normalize(values[0]);
                    const allSame = values.every(v => {
                        const c = normalize(v);
                        return Math.abs(c.r - firstColor.r) < 0.01 && Math.abs(c.g - firstColor.g) < 0.01 &&
                               Math.abs(c.b - firstColor.b) < 0.01 && Math.abs(c.a - firstColor.a) < 0.01;
                    });

                    const field = new ColorField({
                        value: allSame ? firstColor : { r: 0.5, g: 0.5, b: 0.5, a: 1 },
                        onFinishChange: (newVal) => {
                            const cmds = entities.map((ent, i) => {
                                const cur = (components[i] as any)[fieldDef.name];
                                let oldVal: any;
                                if (Array.isArray(cur)) oldVal = [...cur];
                                else if (typeof cur?.toJSON === 'function') oldVal = cur.toJSON();
                                else oldVal = { ...cur };
                                const finalVal = Array.isArray(cur) ? [newVal.r, newVal.g, newVal.b, newVal.a] : newVal;
                                return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, oldVal, finalVal);
                            });
                            ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
                            ctx.emit('historyChanged');
                        },
                    });
                    valueContainer.appendChild(field.el);
                    break;
                }

                case 'asset': {
                    const firstVal = values[0] ?? null;
                    const allSame = values.every(v => (v ?? null) === firstVal);

                    const field = new AssetField({
                        value: allSame ? firstVal : null,
                        assetType: fieldDef.assetType,
                        onChange: (newVal) => {
                            const cmds = entities.map((ent, i) => {
                                const old = (components[i] as any)[fieldDef.name] ?? null;
                                return new ChangePropertyCommand(ent.id, componentType, fieldDef.name, old, newVal);
                            });
                            ctx.undoManager.execute(new BatchCommand('Change Property', cmds));
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
    }

    private appendMixedLabel(container: HTMLElement): void {
        const mixed = document.createElement('span');
        mixed.textContent = '\u2014 Mixed \u2014';
        mixed.style.cssText = 'color: var(--text-disabled, #666); font-size: 11px; font-style: italic;';
        container.appendChild(mixed);
    }
}
