export interface EnumFieldOptions {
    label?: string;
    value?: string;
    options: { value: string; label: string }[];
    onChange?: (value: string) => void;
}

/**
 * Dropdown select for enumerated values.
 */
export class EnumField {
    readonly el: HTMLElement;
    private select: HTMLSelectElement;
    private optionsDef: EnumFieldOptions;

    constructor(options: EnumFieldOptions) {
        this.optionsDef = options;

        this.el = document.createElement('div');
        this.el.className = 'enum-field';

        this.select = document.createElement('select');
        for (const opt of options.options) {
            const optionEl = document.createElement('option');
            optionEl.value = opt.value;
            optionEl.textContent = opt.label;
            this.select.appendChild(optionEl);
        }
        if (options.value != null) {
            this.select.value = String(options.value);
        }
        this.el.appendChild(this.select);

        this.select.addEventListener('change', () => {
            this.optionsDef.onChange?.(this.select.value);
        });
    }

    getValue(): string {
        return this.select.value;
    }

    setValue(v: string, silent: boolean = false): void {
        this.select.value = v;
        if (!silent) this.optionsDef.onChange?.(v);
    }
}
