export interface StringFieldOptions {
    label?: string;
    value?: string;
    placeholder?: string;
    onChange?: (value: string) => void;
    onFinishChange?: (value: string) => void;
}

/**
 * Single-line text input field.
 */
export class StringField {
    readonly el: HTMLElement;
    private input: HTMLInputElement;
    private options: StringFieldOptions;

    constructor(options: StringFieldOptions = {}) {
        this.options = options;

        this.el = document.createElement('div');
        this.el.className = 'string-field';

        this.input = document.createElement('input');
        this.input.type = 'text';
        this.input.value = options.value ?? '';
        if (options.placeholder) this.input.placeholder = options.placeholder;
        this.el.appendChild(this.input);

        this.input.addEventListener('input', () => {
            this.options.onChange?.(this.input.value);
        });

        this.input.addEventListener('change', () => {
            this.options.onFinishChange?.(this.input.value);
        });

        this.input.addEventListener('focus', () => {
            this.input.select();
        });
    }

    getValue(): string {
        return this.input.value;
    }

    setValue(v: string, silent: boolean = false): void {
        this.input.value = v;
        if (!silent) this.options.onChange?.(v);
    }
}
