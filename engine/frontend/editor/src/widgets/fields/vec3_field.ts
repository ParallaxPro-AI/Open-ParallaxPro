export interface Vec3FieldOptions {
    label?: string;
    value?: { x: number; y: number; z: number };
    step?: number;
    precision?: number;
    onChange?: (value: { x: number; y: number; z: number }) => void;
    onFinishChange?: (value: { x: number; y: number; z: number }) => void;
}

/**
 * Three-component vector field (X, Y, Z) with colored labels.
 */
export class Vec3Field {
    readonly el: HTMLElement;
    private value: { x: number; y: number; z: number };
    private inputs: { x: HTMLInputElement; y: HTMLInputElement; z: HTMLInputElement };
    private options: Vec3FieldOptions;

    constructor(options: Vec3FieldOptions = {}) {
        this.options = options;
        this.value = {
            x: options.value?.x ?? 0,
            y: options.value?.y ?? 0,
            z: options.value?.z ?? 0,
        };

        this.el = document.createElement('div');
        this.el.className = 'vec-field';

        this.inputs = {
            x: this.createComponent('x', 'X', this.value.x),
            y: this.createComponent('y', 'Y', this.value.y),
            z: this.createComponent('z', 'Z', this.value.z),
        };
    }

    private createComponent(axis: 'x' | 'y' | 'z', label: string, value: number): HTMLInputElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'vec-component';

        const lbl = document.createElement('span');
        lbl.className = `vec-component-label ${axis}`;
        lbl.textContent = label;
        wrapper.appendChild(lbl);

        const input = document.createElement('input');
        input.type = 'number';
        input.value = this.formatValue(value);
        input.step = String(this.options.step ?? 0.1);
        wrapper.appendChild(input);

        input.addEventListener('change', () => {
            this.value[axis] = parseFloat(input.value) || 0;
            input.value = this.formatValue(this.value[axis]);
            this.options.onChange?.({ ...this.value });
            this.options.onFinishChange?.({ ...this.value });
        });

        input.addEventListener('focus', () => input.select());

        this.el.appendChild(wrapper);
        return input;
    }

    getValue(): { x: number; y: number; z: number } {
        return { ...this.value };
    }

    setValue(v: { x: number; y: number; z: number }, silent: boolean = false): void {
        this.value = { x: v.x, y: v.y, z: v.z };
        this.inputs.x.value = this.formatValue(v.x);
        this.inputs.y.value = this.formatValue(v.y);
        this.inputs.z.value = this.formatValue(v.z);
        if (!silent) this.options.onChange?.({ ...this.value });
    }

    private formatValue(v: number): string {
        const precision = this.options.precision ?? 3;
        return parseFloat(v.toFixed(precision)).toString();
    }
}
