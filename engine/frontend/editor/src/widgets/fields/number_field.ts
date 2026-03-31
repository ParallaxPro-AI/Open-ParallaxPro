export interface NumberFieldOptions {
    label?: string;
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    precision?: number;
    draggable?: boolean;
    onChange?: (value: number) => void;
    onFinishChange?: (value: number) => void;
}

/**
 * Number input field with optional drag-to-scrub behavior.
 */
export class NumberField {
    readonly el: HTMLElement;
    private input: HTMLInputElement;
    private value: number;
    private options: NumberFieldOptions;
    private isDragging: boolean = false;
    private dragStartX: number = 0;
    private dragStartValue: number = 0;

    constructor(options: NumberFieldOptions = {}) {
        this.options = options;
        this.value = options.value ?? 0;

        this.el = document.createElement('div');
        this.el.className = 'number-field';
        if (options.draggable !== false) this.el.classList.add('draggable');

        this.input = document.createElement('input');
        this.input.type = 'number';
        this.input.value = this.formatValue(this.value);
        if (options.min !== undefined) this.input.min = String(options.min);
        if (options.max !== undefined) this.input.max = String(options.max);
        if (options.step !== undefined) this.input.step = String(options.step);
        this.el.appendChild(this.input);

        this.input.addEventListener('change', () => {
            const v = this.clamp(parseFloat(this.input.value) || 0);
            this.value = v;
            this.input.value = this.formatValue(v);
            this.options.onChange?.(v);
            this.options.onFinishChange?.(v);
        });

        this.input.addEventListener('focus', () => {
            this.input.select();
        });

        // Drag-to-scrub: click and drag horizontally to adjust value
        if (options.draggable !== false) {
            this.input.addEventListener('mousedown', (e) => {
                if (document.activeElement === this.input) return;
                e.preventDefault();
                this.isDragging = true;
                this.dragStartX = e.clientX;
                this.dragStartValue = this.value;
                let hasMoved = false;

                const onMouseMove = (me: MouseEvent) => {
                    const dx = me.clientX - this.dragStartX;
                    if (!hasMoved && Math.abs(dx) < 3) return;
                    hasMoved = true;
                    const step = this.options.step ?? 0.1;
                    const delta = dx * step;
                    const newVal = this.clamp(this.dragStartValue + delta);
                    this.value = newVal;
                    this.input.value = this.formatValue(newVal);
                    this.options.onChange?.(newVal);
                };

                const onMouseUp = () => {
                    this.isDragging = false;
                    window.removeEventListener('mousemove', onMouseMove);
                    window.removeEventListener('mouseup', onMouseUp);
                    if (hasMoved && this.value !== this.dragStartValue) {
                        this.options.onFinishChange?.(this.value);
                    } else if (!hasMoved) {
                        this.input.focus();
                        this.input.select();
                    }
                };

                window.addEventListener('mousemove', onMouseMove);
                window.addEventListener('mouseup', onMouseUp);
            });
        }
    }

    getValue(): number {
        return this.value;
    }

    setValue(v: number, silent: boolean = false): void {
        this.value = this.clamp(v);
        this.input.value = this.formatValue(this.value);
        if (!silent) this.options.onChange?.(this.value);
    }

    private clamp(v: number): number {
        if (this.options.min !== undefined && v < this.options.min) v = this.options.min;
        if (this.options.max !== undefined && v > this.options.max) v = this.options.max;
        return v;
    }

    private formatValue(v: number): string {
        const precision = this.options.precision ?? 3;
        return parseFloat(v.toFixed(precision)).toString();
    }
}
