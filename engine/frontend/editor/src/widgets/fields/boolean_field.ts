export interface BooleanFieldOptions {
    label?: string;
    value?: boolean;
    onChange?: (value: boolean) => void;
}

/**
 * Toggle switch for boolean values.
 */
export class BooleanField {
    readonly el: HTMLElement;
    private value: boolean;
    private toggle: HTMLElement;
    private options: BooleanFieldOptions;

    constructor(options: BooleanFieldOptions = {}) {
        this.options = options;
        this.value = options.value ?? false;

        this.el = document.createElement('div');
        this.el.className = 'boolean-field';

        this.toggle = document.createElement('div');
        this.toggle.className = 'toggle';
        if (this.value) this.toggle.classList.add('active');
        this.el.appendChild(this.toggle);

        this.toggle.addEventListener('click', () => {
            this.value = !this.value;
            this.toggle.classList.toggle('active', this.value);
            this.options.onChange?.(this.value);
        });
    }

    getValue(): boolean {
        return this.value;
    }

    setValue(v: boolean, silent: boolean = false): void {
        this.value = v;
        this.toggle.classList.toggle('active', v);
        if (!silent) this.options.onChange?.(v);
    }
}
