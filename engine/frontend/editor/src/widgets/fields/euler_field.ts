export interface EulerFieldOptions {
    label?: string;
    value?: { x: number; y: number; z: number };
    onChange?: (valueDeg: { x: number; y: number; z: number }) => void;
    onFinishChange?: (valueDeg: { x: number; y: number; z: number }) => void;
}

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

/**
 * Euler angle field (X, Y, Z). Stores values in radians internally,
 * displays and accepts input in degrees.
 */
export class EulerField {
    readonly el: HTMLElement;
    private value: { x: number; y: number; z: number };
    private inputs: { x: HTMLInputElement; y: HTMLInputElement; z: HTMLInputElement };
    private options: EulerFieldOptions;

    constructor(options: EulerFieldOptions = {}) {
        this.options = options;
        this.value = {
            x: options.value?.x ?? 0,
            y: options.value?.y ?? 0,
            z: options.value?.z ?? 0,
        };

        this.el = document.createElement('div');
        this.el.className = 'vec-field';

        this.inputs = {
            x: this.createComponent('x', 'X', this.value.x * RAD_TO_DEG),
            y: this.createComponent('y', 'Y', this.value.y * RAD_TO_DEG),
            z: this.createComponent('z', 'Z', this.value.z * RAD_TO_DEG),
        };
    }

    private createComponent(axis: 'x' | 'y' | 'z', label: string, valueDeg: number): HTMLInputElement {
        const wrapper = document.createElement('div');
        wrapper.className = 'vec-component';

        const lbl = document.createElement('span');
        lbl.className = `vec-component-label ${axis}`;
        lbl.textContent = label;
        wrapper.appendChild(lbl);

        const input = document.createElement('input');
        input.type = 'number';
        input.value = this.formatDeg(valueDeg);
        input.step = '1';
        wrapper.appendChild(input);

        input.addEventListener('change', () => {
            const deg = parseFloat(input.value) || 0;
            this.value[axis] = deg * DEG_TO_RAD;
            input.value = this.formatDeg(deg);
            const degValue = {
                x: this.value.x * RAD_TO_DEG,
                y: this.value.y * RAD_TO_DEG,
                z: this.value.z * RAD_TO_DEG,
            };
            this.options.onChange?.(degValue);
            this.options.onFinishChange?.(degValue);
        });

        input.addEventListener('focus', () => input.select());

        this.el.appendChild(wrapper);
        return input;
    }

    /** Get value in radians. */
    getValue(): { x: number; y: number; z: number } {
        return { ...this.value };
    }

    /** Get value in degrees. */
    getValueDegrees(): { x: number; y: number; z: number } {
        return {
            x: this.value.x * RAD_TO_DEG,
            y: this.value.y * RAD_TO_DEG,
            z: this.value.z * RAD_TO_DEG,
        };
    }

    /** Set value in radians. */
    setValue(v: { x: number; y: number; z: number }, silent: boolean = false): void {
        this.value = { x: v.x, y: v.y, z: v.z };
        this.inputs.x.value = this.formatDeg(v.x * RAD_TO_DEG);
        this.inputs.y.value = this.formatDeg(v.y * RAD_TO_DEG);
        this.inputs.z.value = this.formatDeg(v.z * RAD_TO_DEG);
        if (!silent) {
            this.options.onChange?.({
                x: v.x * RAD_TO_DEG,
                y: v.y * RAD_TO_DEG,
                z: v.z * RAD_TO_DEG,
            });
        }
    }

    private formatDeg(deg: number): string {
        return parseFloat(deg.toFixed(1)).toString();
    }
}
