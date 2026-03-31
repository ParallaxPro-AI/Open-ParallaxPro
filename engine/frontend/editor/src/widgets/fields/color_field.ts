export interface ColorFieldOptions {
    label?: string;
    value?: { r: number; g: number; b: number; a?: number };
    onChange?: (value: { r: number; g: number; b: number; a: number }) => void;
    onFinishChange?: (value: { r: number; g: number; b: number; a: number }) => void;
}

/**
 * Color picker with swatch preview and hex input.
 * Uses the native HTML color input as a popup.
 */
export class ColorField {
    readonly el: HTMLElement;
    private swatch: HTMLElement;
    private hexInput: HTMLInputElement;
    private nativePicker: HTMLInputElement;
    private value: { r: number; g: number; b: number; a: number };
    private options: ColorFieldOptions;

    constructor(options: ColorFieldOptions = {}) {
        this.options = options;
        this.value = {
            r: options.value?.r ?? 1,
            g: options.value?.g ?? 1,
            b: options.value?.b ?? 1,
            a: options.value?.a ?? 1,
        };

        this.el = document.createElement('div');
        this.el.className = 'color-field';

        this.swatch = document.createElement('div');
        this.swatch.className = 'color-swatch';
        this.updateSwatchColor();
        this.el.appendChild(this.swatch);

        this.hexInput = document.createElement('input');
        this.hexInput.className = 'color-hex-input';
        this.hexInput.type = 'text';
        this.hexInput.value = this.toHex();
        this.el.appendChild(this.hexInput);

        // Native color picker (hidden, triggered by swatch click)
        this.nativePicker = document.createElement('input');
        this.nativePicker.type = 'color';
        this.nativePicker.className = 'color-picker-native';
        this.nativePicker.value = this.toHex();
        this.el.appendChild(this.nativePicker);

        this.swatch.addEventListener('click', () => {
            this.nativePicker.click();
        });

        this.nativePicker.addEventListener('input', () => {
            this.setFromHex(this.nativePicker.value);
            this.hexInput.value = this.toHex();
            this.updateSwatchColor();
            this.options.onChange?.({ ...this.value });
        });

        this.nativePicker.addEventListener('change', () => {
            this.options.onFinishChange?.({ ...this.value });
        });

        this.hexInput.addEventListener('change', () => {
            let hex = this.hexInput.value.trim();
            if (!hex.startsWith('#')) hex = '#' + hex;
            if (/^#[0-9a-fA-F]{6}$/.test(hex)) {
                this.setFromHex(hex);
                this.nativePicker.value = hex;
                this.updateSwatchColor();
                this.options.onChange?.({ ...this.value });
                this.options.onFinishChange?.({ ...this.value });
            } else {
                this.hexInput.value = this.toHex();
            }
        });
    }

    getValue(): { r: number; g: number; b: number; a: number } {
        return { ...this.value };
    }

    setValue(v: { r: number; g: number; b: number; a?: number }, silent: boolean = false): void {
        this.value = { r: v.r, g: v.g, b: v.b, a: v.a ?? 1 };
        this.hexInput.value = this.toHex();
        this.nativePicker.value = this.toHex();
        this.updateSwatchColor();
        if (!silent) this.options.onChange?.({ ...this.value });
    }

    private toHex(): string {
        const r = Math.round(Math.max(0, Math.min(1, this.value.r)) * 255);
        const g = Math.round(Math.max(0, Math.min(1, this.value.g)) * 255);
        const b = Math.round(Math.max(0, Math.min(1, this.value.b)) * 255);
        return '#' + this.hex2(r) + this.hex2(g) + this.hex2(b);
    }

    private hex2(v: number): string {
        const s = v.toString(16);
        return s.length < 2 ? '0' + s : s;
    }

    private setFromHex(hex: string): void {
        const str = hex.replace('#', '');
        this.value.r = parseInt(str.substring(0, 2), 16) / 255;
        this.value.g = parseInt(str.substring(2, 4), 16) / 255;
        this.value.b = parseInt(str.substring(4, 6), 16) / 255;
    }

    private updateSwatchColor(): void {
        this.swatch.style.backgroundColor = this.toHex();
    }
}
