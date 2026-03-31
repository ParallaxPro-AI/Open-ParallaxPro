export type UIAnchor =
    'top-left' | 'top-center' | 'top-right' |
    'center-left' | 'center' | 'center-right' |
    'bottom-left' | 'bottom-center' | 'bottom-right';

export interface UIBaseOptions {
    anchor?: UIAnchor;
    x?: number;
    y?: number;
    width?: number | string;
    height?: number | string;
    visible?: boolean;
    opacity?: number;
    backgroundColor?: string;
    border?: string;
    borderRadius?: number;
    padding?: number;
}

export interface UITextOptions extends UIBaseOptions {
    text?: string;
    fontSize?: number;
    color?: string;
    fontFamily?: string;
    textAlign?: 'left' | 'center' | 'right';
    textShadow?: string;
    bold?: boolean;
}

export interface UIImageOptions extends UIBaseOptions {
    src?: string;
    fit?: 'fill' | 'contain' | 'cover';
}

export interface UIButtonOptions extends UIBaseOptions {
    text?: string;
    fontSize?: number;
    color?: string;
    onClick?: () => void;
}

export interface UIPanelOptions extends UIBaseOptions {
    layout?: 'none' | 'horizontal' | 'vertical';
    gap?: number;
    alignItems?: 'start' | 'center' | 'end' | 'stretch';
    justifyContent?: 'start' | 'center' | 'end' | 'space-between' | 'space-around';
}

export interface UIProgressBarOptions extends UIBaseOptions {
    value?: number;
    barColor?: string;
}

export interface UITextInputOptions extends UIBaseOptions {
    placeholder?: string;
    value?: string;
    fontSize?: number;
    color?: string;
    maxLength?: number;
    type?: 'text' | 'password' | 'number';
    onChange?: (value: string) => void;
    onSubmit?: (value: string) => void;
}

export interface UIScrollViewOptions extends UIBaseOptions {
    scrollDirection?: 'vertical' | 'horizontal' | 'both';
    showScrollbar?: boolean;
}

export interface UISliderOptions extends UIBaseOptions {
    value?: number;
    min?: number;
    max?: number;
    step?: number;
    barColor?: string;
    thumbColor?: string;
    onChange?: (value: number) => void;
}

export interface UIDropdownOptions extends UIBaseOptions {
    options?: ({ value: string; label: string } | string)[];
    selected?: string;
    fontSize?: number;
    color?: string;
    onChange?: (value: string) => void;
}

export interface UIGridOptions extends UIBaseOptions {
    columns?: number;
    cellWidth?: number;
    cellHeight?: number;
    gap?: number;
}

export interface UITooltipOptions {
    text?: string;
    fontSize?: number;
    backgroundColor?: string;
    color?: string;
    delay?: number;
}

// --- UIElement (base) ---

export class UIElement {
    /** @internal */ readonly _dom: HTMLElement;
    /** @internal */ _parent: UIPanel | null = null;
    /** @internal */ _system: GameUISystem | null = null;

    private _anchor: UIAnchor = 'top-left';
    private _x: number = 0;
    private _y: number = 0;
    private _visible: boolean = true;
    private _opacity: number = 1;
    private _width: number | string = 0;
    private _height: number | string = 0;
    private _backgroundColor: string = '';
    private _border: string = '';
    private _borderRadius: number = 0;
    private _padding: number = 0;

    /** @internal */
    constructor(tag: string = 'div') {
        this._dom = document.createElement(tag);
        this._dom.style.position = 'absolute';
        this._dom.style.pointerEvents = 'none';
    }

    get anchor(): UIAnchor { return this._anchor; }
    set anchor(v: UIAnchor) { this._anchor = v; this._applyPosition(); }

    get x(): number { return this._x; }
    set x(v: number) { this._x = v; this._applyPosition(); }

    get y(): number { return this._y; }
    set y(v: number) { this._y = v; this._applyPosition(); }

    get width(): number | string { return this._width; }
    set width(v: number | string) {
        this._width = v;
        this._dom.style.width = typeof v === 'number' ? (v > 0 ? v + 'px' : '') : v;
    }

    get height(): number | string { return this._height; }
    set height(v: number | string) {
        this._height = v;
        this._dom.style.height = typeof v === 'number' ? (v > 0 ? v + 'px' : '') : v;
    }

    get visible(): boolean { return this._visible; }
    set visible(v: boolean) { this._visible = v; this._dom.style.display = v ? '' : 'none'; }

    get opacity(): number { return this._opacity; }
    set opacity(v: number) { this._opacity = v; this._dom.style.opacity = String(v); }

    get backgroundColor(): string { return this._backgroundColor; }
    set backgroundColor(v: string) { this._backgroundColor = v; this._dom.style.backgroundColor = v; }

    get border(): string { return this._border; }
    set border(v: string) { this._border = v; this._dom.style.border = v; }

    get borderRadius(): number { return this._borderRadius; }
    set borderRadius(v: number) { this._borderRadius = v; this._dom.style.borderRadius = v + 'px'; }

    get padding(): number { return this._padding; }
    set padding(v: number) { this._padding = v; this._dom.style.padding = v + 'px'; }

    destroy(): void {
        if (this._dom.parentNode) {
            this._dom.parentNode.removeChild(this._dom);
        }
        if (this._parent) {
            this._parent._children.delete(this);
            this._parent = null;
        }
        if (this._system) {
            this._system._unregister(this);
        }
    }

    /** @internal */
    _applyBaseOptions(options: UIBaseOptions): void {
        if (options.anchor !== undefined) this._anchor = options.anchor;
        if (options.x !== undefined) this._x = options.x;
        if (options.y !== undefined) this._y = options.y;
        if (options.width !== undefined) this.width = options.width;
        if (options.height !== undefined) this.height = options.height;
        if (options.visible !== undefined) this.visible = options.visible;
        if (options.opacity !== undefined) this.opacity = options.opacity;
        if (options.backgroundColor !== undefined) this.backgroundColor = options.backgroundColor;
        if (options.border !== undefined) this.border = options.border;
        if (options.borderRadius !== undefined) this.borderRadius = options.borderRadius;
        if (options.padding !== undefined) this.padding = options.padding;
        this._applyPosition();
    }

    /**
     * Apply CSS positioning based on anchor + offset.
     * When inside a UIPanel, positioning is delegated to the panel's flex layout.
     * @internal
     */
    _applyPosition(): void {
        const s = this._dom.style;

        if (this._parent) {
            s.position = 'relative';
            s.top = ''; s.bottom = ''; s.left = ''; s.right = '';
            s.transform = '';
            return;
        }

        s.position = 'absolute';
        s.top = ''; s.bottom = ''; s.left = ''; s.right = '';
        s.transform = '';

        const a = this._anchor;
        const x = this._x;
        const y = this._y;

        if (a.includes('left')) {
            s.left = x + 'px';
        } else if (a.includes('right')) {
            s.right = x + 'px';
        } else {
            s.left = x ? `calc(50% + ${x}px)` : '50%';
        }

        if (a.startsWith('top')) {
            s.top = y + 'px';
        } else if (a.startsWith('bottom')) {
            s.bottom = y + 'px';
        } else {
            s.top = y ? `calc(50% + ${y}px)` : '50%';
        }

        const centerH = !a.includes('left') && !a.includes('right');
        const centerV = !a.startsWith('top') && !a.startsWith('bottom');
        if (centerH && centerV) {
            s.transform = 'translate(-50%, -50%)';
        } else if (centerH) {
            s.transform = 'translateX(-50%)';
        } else if (centerV) {
            s.transform = 'translateY(-50%)';
        }
    }
}

// --- UIText ---

export class UIText extends UIElement {
    private _text: string = '';
    private _fontSize: number = 16;
    private _color: string = 'white';
    private _fontFamily: string = 'monospace';
    private _textAlign: string = 'left';
    private _textShadow: string = '';
    private _bold: boolean = false;

    /** @internal */
    constructor(options?: UITextOptions) {
        super('div');
        if (options) {
            if (options.text !== undefined) { this._text = options.text; this._dom.textContent = options.text; }
            if (options.fontSize !== undefined) { this._fontSize = options.fontSize; this._dom.style.fontSize = options.fontSize + 'px'; }
            if (options.color !== undefined) { this._color = options.color; this._dom.style.color = options.color; }
            if (options.fontFamily !== undefined) { this._fontFamily = options.fontFamily; this._dom.style.fontFamily = options.fontFamily; }
            if (options.textAlign !== undefined) { this._textAlign = options.textAlign; this._dom.style.textAlign = options.textAlign; }
            if (options.textShadow !== undefined) { this._textShadow = options.textShadow; this._dom.style.textShadow = options.textShadow; }
            if (options.bold !== undefined) { this._bold = options.bold; this._dom.style.fontWeight = options.bold ? 'bold' : ''; }
            this._applyBaseOptions(options);
        } else {
            this._dom.style.fontSize = this._fontSize + 'px';
            this._dom.style.color = this._color;
            this._dom.style.fontFamily = this._fontFamily;
            this._applyPosition();
        }
    }

    get text(): string { return this._text; }
    set text(v: string) { this._text = v; this._dom.textContent = v; }

    get fontSize(): number { return this._fontSize; }
    set fontSize(v: number) { this._fontSize = v; this._dom.style.fontSize = v + 'px'; }

    get color(): string { return this._color; }
    set color(v: string) { this._color = v; this._dom.style.color = v; }

    get fontFamily(): string { return this._fontFamily; }
    set fontFamily(v: string) { this._fontFamily = v; this._dom.style.fontFamily = v; }

    get textAlign(): string { return this._textAlign; }
    set textAlign(v: string) { this._textAlign = v; this._dom.style.textAlign = v; }

    get textShadow(): string { return this._textShadow; }
    set textShadow(v: string) { this._textShadow = v; this._dom.style.textShadow = v; }

    get bold(): boolean { return this._bold; }
    set bold(v: boolean) { this._bold = v; this._dom.style.fontWeight = v ? 'bold' : ''; }
}

// --- UIImage ---

export class UIImage extends UIElement {
    private _src: string = '';
    private _fit: string = 'contain';
    private _imgEl: HTMLImageElement;

    /** @internal */
    constructor(options?: UIImageOptions) {
        super('div');
        this._imgEl = document.createElement('img');
        this._imgEl.style.width = '100%';
        this._imgEl.style.height = '100%';
        this._imgEl.style.display = 'block';
        this._imgEl.draggable = false;
        this._dom.appendChild(this._imgEl);
        this._dom.style.overflow = 'hidden';

        if (options) {
            if (options.src !== undefined) { this._src = options.src; this._imgEl.src = options.src; }
            if (options.fit !== undefined) { this._fit = options.fit; this._imgEl.style.objectFit = options.fit; }
            this._applyBaseOptions(options);
        } else {
            this._imgEl.style.objectFit = this._fit;
            this._applyPosition();
        }
    }

    get src(): string { return this._src; }
    set src(v: string) { this._src = v; this._imgEl.src = v; }

    get fit(): string { return this._fit; }
    set fit(v: string) { this._fit = v; this._imgEl.style.objectFit = v; }
}

// --- UIButton ---

export class UIButton extends UIElement {
    private _text: string = '';
    private _fontSize: number = 16;
    private _color: string = 'white';
    private _onClick: (() => void) | null = null;
    private _boundClick: () => void;

    /** @internal */
    constructor(options?: UIButtonOptions) {
        super('div');
        const s = this._dom.style;
        s.pointerEvents = 'auto';
        s.cursor = 'pointer';
        s.userSelect = 'none';
        s.textAlign = 'center';
        s.fontFamily = 'monospace';
        s.fontSize = this._fontSize + 'px';
        s.color = this._color;
        s.backgroundColor = 'rgba(60,60,60,0.8)';
        s.border = '1px solid #888';
        s.padding = '6px 12px';
        s.borderRadius = '4px';

        this._boundClick = () => { if (this._onClick) this._onClick(); };
        this._dom.addEventListener('click', this._boundClick);

        if (options) {
            if (options.text !== undefined) { this._text = options.text; this._dom.textContent = options.text; }
            if (options.fontSize !== undefined) { this._fontSize = options.fontSize; this._dom.style.fontSize = options.fontSize + 'px'; }
            if (options.color !== undefined) { this._color = options.color; this._dom.style.color = options.color; }
            if (options.onClick !== undefined) { this._onClick = options.onClick; }
            this._applyBaseOptions(options);
        } else {
            this._applyPosition();
        }
    }

    get text(): string { return this._text; }
    set text(v: string) { this._text = v; this._dom.textContent = v; }

    get fontSize(): number { return this._fontSize; }
    set fontSize(v: number) { this._fontSize = v; this._dom.style.fontSize = v + 'px'; }

    get color(): string { return this._color; }
    set color(v: string) { this._color = v; this._dom.style.color = v; }

    get onClick(): (() => void) | null { return this._onClick; }
    set onClick(v: (() => void) | null) { this._onClick = v; }

    destroy(): void {
        this._dom.removeEventListener('click', this._boundClick);
        super.destroy();
    }
}

// --- UIPanel ---

export class UIPanel extends UIElement {
    /** @internal */ _children: Set<UIElement> = new Set();

    private _layout: 'none' | 'horizontal' | 'vertical' = 'none';
    private _gap: number = 0;
    private _alignItems: string = 'start';
    private _justifyContent: string = 'start';

    /** @internal */
    constructor(options?: UIPanelOptions) {
        super('div');
        if (options) {
            if (options.layout !== undefined) this._setLayout(options.layout);
            if (options.gap !== undefined) { this._gap = options.gap; this._dom.style.gap = options.gap + 'px'; }
            if (options.alignItems !== undefined) { this._alignItems = options.alignItems; this._dom.style.alignItems = this._cssAlign(options.alignItems); }
            if (options.justifyContent !== undefined) { this._justifyContent = options.justifyContent; this._dom.style.justifyContent = this._cssAlign(options.justifyContent); }
            this._applyBaseOptions(options);
        } else {
            this._applyPosition();
        }
    }

    override get visible(): boolean { return super.visible; }
    override set visible(v: boolean) {
        super.visible = v;
        if (v && this._layout !== 'none') {
            this._dom.style.display = 'flex';
        }
    }

    get layout(): 'none' | 'horizontal' | 'vertical' { return this._layout; }
    set layout(v: 'none' | 'horizontal' | 'vertical') { this._setLayout(v); }

    get gap(): number { return this._gap; }
    set gap(v: number) { this._gap = v; this._dom.style.gap = v + 'px'; }

    get alignItems(): string { return this._alignItems; }
    set alignItems(v: string) { this._alignItems = v; this._dom.style.alignItems = this._cssAlign(v); }

    get justifyContent(): string { return this._justifyContent; }
    set justifyContent(v: string) { this._justifyContent = v; this._dom.style.justifyContent = this._cssAlign(v); }

    addChild(child: UIElement): void {
        if (child._parent) {
            child._parent._children.delete(child);
        } else if (child._dom.parentNode) {
            child._dom.parentNode.removeChild(child._dom);
        }
        child._parent = this;
        this._children.add(child);
        this._dom.appendChild(child._dom);
        child._applyPosition();
    }

    removeChild(child: UIElement): void {
        if (!this._children.has(child)) return;
        this._children.delete(child);
        if (child._dom.parentNode === this._dom) {
            this._dom.removeChild(child._dom);
        }
        child._parent = null;
        if (child._system) {
            child._system._getOverlayDom().appendChild(child._dom);
        }
        child._applyPosition();
    }

    clearChildren(): void {
        for (const child of this._children) {
            if (child._dom.parentNode === this._dom) {
                this._dom.removeChild(child._dom);
            }
            child._parent = null;
        }
        this._children.clear();
    }

    destroy(): void {
        for (const child of this._children) {
            child._parent = null;
            child.destroy();
        }
        this._children.clear();
        super.destroy();
    }

    private _setLayout(v: 'none' | 'horizontal' | 'vertical'): void {
        this._layout = v;
        if (v === 'none') {
            this._dom.style.display = '';
        } else {
            this._dom.style.display = 'flex';
            this._dom.style.flexDirection = v === 'horizontal' ? 'row' : 'column';
        }
    }

    private _cssAlign(v: string): string {
        if (v === 'start') return 'flex-start';
        if (v === 'end') return 'flex-end';
        return v;
    }
}

// --- UIProgressBar ---

export class UIProgressBar extends UIElement {
    private _value: number = 1;
    private _barColor: string = '#4CAF50';
    private _fillDom: HTMLElement;

    /** @internal */
    constructor(options?: UIProgressBarOptions) {
        super('div');
        const s = this._dom.style;
        s.overflow = 'hidden';
        s.backgroundColor = 'rgba(0,0,0,0.5)';
        s.width = '200px';
        s.height = '20px';

        this._fillDom = document.createElement('div');
        this._fillDom.style.height = '100%';
        this._fillDom.style.width = '100%';
        this._fillDom.style.backgroundColor = this._barColor;
        this._fillDom.style.transition = 'width 0.1s ease';
        this._dom.appendChild(this._fillDom);

        if (options) {
            if (options.value !== undefined) { this._value = Math.max(0, Math.min(1, options.value)); this._fillDom.style.width = (this._value * 100) + '%'; }
            if (options.barColor !== undefined) { this._barColor = options.barColor; this._fillDom.style.backgroundColor = options.barColor; }
            this._applyBaseOptions(options);
        } else {
            this._applyPosition();
        }
    }

    get value(): number { return this._value; }
    set value(v: number) {
        this._value = Math.max(0, Math.min(1, v));
        this._fillDom.style.width = (this._value * 100) + '%';
    }

    get barColor(): string { return this._barColor; }
    set barColor(v: string) { this._barColor = v; this._fillDom.style.backgroundColor = v; }
}

// --- UITextInput ---

export class UITextInput extends UIElement {
    private _inputEl: HTMLInputElement;
    private _value: string = '';
    private _onChange: ((value: string) => void) | null = null;
    private _onSubmit: ((value: string) => void) | null = null;

    constructor(options?: UITextInputOptions) {
        super('div');
        this._inputEl = document.createElement('input');
        this._inputEl.type = options?.type ?? 'text';
        this._inputEl.style.cssText = `
            width: 100%; height: 100%; box-sizing: border-box;
            background: rgba(0,0,0,0.6); border: 1px solid #666;
            color: ${options?.color ?? 'white'}; font-family: monospace;
            font-size: ${options?.fontSize ?? 14}px; padding: 4px 8px;
            border-radius: 4px; outline: none;
        `;
        this._inputEl.style.pointerEvents = 'auto';
        this._dom.style.pointerEvents = 'auto';

        if (options?.placeholder) this._inputEl.placeholder = options.placeholder;
        if (options?.value) { this._value = options.value; this._inputEl.value = options.value; }
        if (options?.maxLength) this._inputEl.maxLength = options.maxLength;
        if (options?.onChange) this._onChange = options.onChange;
        if (options?.onSubmit) this._onSubmit = options.onSubmit;

        this._inputEl.addEventListener('input', () => {
            this._value = this._inputEl.value;
            if (this._onChange) this._onChange(this._value);
        });
        this._inputEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && this._onSubmit) {
                this._onSubmit(this._value);
            }
            e.stopPropagation();
        });

        this._dom.appendChild(this._inputEl);
        if (options) this._applyBaseOptions(options);
        else this._applyPosition();
    }

    get value(): string { return this._value; }
    set value(v: string) { this._value = v; this._inputEl.value = v; }

    get placeholder(): string { return this._inputEl.placeholder; }
    set placeholder(v: string) { this._inputEl.placeholder = v; }

    get onChange(): ((value: string) => void) | null { return this._onChange; }
    set onChange(v: ((value: string) => void) | null) { this._onChange = v; }

    get onSubmit(): ((value: string) => void) | null { return this._onSubmit; }
    set onSubmit(v: ((value: string) => void) | null) { this._onSubmit = v; }

    focus(): void { this._inputEl.focus(); }
    blur(): void { this._inputEl.blur(); }
}

// --- UIScrollView ---

export class UIScrollView extends UIElement {
    private _contentDom: HTMLElement;
    _children: Set<UIElement> = new Set();

    constructor(options?: UIScrollViewOptions) {
        super('div');
        const dir = options?.scrollDirection ?? 'vertical';
        const s = this._dom.style;
        s.overflow = dir === 'both' ? 'auto' : dir === 'horizontal' ? 'auto hidden' : 'hidden auto';
        s.pointerEvents = 'auto';

        if (options?.showScrollbar === false) {
            (s as any).scrollbarWidth = 'none';
            (s as any).msOverflowStyle = 'none';
        }

        this._contentDom = document.createElement('div');
        this._contentDom.style.position = 'relative';
        this._contentDom.style.minWidth = 'min-content';
        this._contentDom.style.minHeight = 'min-content';
        this._dom.appendChild(this._contentDom);

        if (options) this._applyBaseOptions(options);
        else this._applyPosition();
    }

    addChild(child: UIElement): void {
        if (child._parent) {
            (child._parent as any)._children?.delete(child);
        } else if (child._dom.parentNode) {
            child._dom.parentNode.removeChild(child._dom);
        }
        child._parent = null;
        this._children.add(child);
        this._contentDom.appendChild(child._dom);
    }

    removeChild(child: UIElement): void {
        if (!this._children.has(child)) return;
        this._children.delete(child);
        if (child._dom.parentNode === this._contentDom) {
            this._contentDom.removeChild(child._dom);
        }
    }

    clearChildren(): void {
        for (const child of this._children) {
            if (child._dom.parentNode === this._contentDom) {
                this._contentDom.removeChild(child._dom);
            }
        }
        this._children.clear();
    }

    scrollTo(x: number, y: number): void {
        this._dom.scrollTo(x, y);
    }

    get scrollTop(): number { return this._dom.scrollTop; }
    set scrollTop(v: number) { this._dom.scrollTop = v; }

    get scrollLeft(): number { return this._dom.scrollLeft; }
    set scrollLeft(v: number) { this._dom.scrollLeft = v; }

    destroy(): void {
        for (const child of this._children) child.destroy();
        this._children.clear();
        super.destroy();
    }
}

// --- UISlider ---

export class UISlider extends UIElement {
    private _value: number = 0.5;
    private _min: number = 0;
    private _max: number = 1;
    private _step: number = 0;
    private _onChange: ((value: number) => void) | null = null;
    private _trackDom: HTMLElement;
    private _thumbDom: HTMLElement;
    private _dragging: boolean = false;

    constructor(options?: UISliderOptions) {
        super('div');
        const s = this._dom.style;
        s.pointerEvents = 'auto';
        s.cursor = 'pointer';
        s.width = '200px';
        s.height = '24px';
        s.position = 'relative';

        this._trackDom = document.createElement('div');
        this._trackDom.style.cssText = `
            position: absolute; top: 50%; left: 0; right: 0;
            height: 6px; transform: translateY(-50%);
            background: ${options?.barColor ?? 'rgba(255,255,255,0.3)'};
            border-radius: 3px;
        `;
        this._dom.appendChild(this._trackDom);

        this._thumbDom = document.createElement('div');
        this._thumbDom.style.cssText = `
            position: absolute; top: 50%; width: 16px; height: 16px;
            transform: translate(-50%, -50%);
            background: ${options?.thumbColor ?? '#fff'};
            border-radius: 50%; cursor: grab;
        `;
        this._dom.appendChild(this._thumbDom);

        this._min = options?.min ?? 0;
        this._max = options?.max ?? 1;
        this._step = options?.step ?? 0;
        if (options?.value !== undefined) this._value = options.value;
        if (options?.onChange) this._onChange = options.onChange;

        this._updateThumbPosition();

        const onMouseDown = (e: MouseEvent) => {
            this._dragging = true;
            this._updateFromMouse(e);
            e.preventDefault();
        };
        const onMouseMove = (e: MouseEvent) => {
            if (!this._dragging) return;
            this._updateFromMouse(e);
        };
        const onMouseUp = () => { this._dragging = false; };

        this._dom.addEventListener('mousedown', onMouseDown);
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);

        if (options) this._applyBaseOptions(options);
        else this._applyPosition();
    }

    get value(): number { return this._value; }
    set value(v: number) {
        this._value = Math.max(this._min, Math.min(this._max, v));
        this._updateThumbPosition();
    }

    get min(): number { return this._min; }
    set min(v: number) { this._min = v; this._updateThumbPosition(); }

    get max(): number { return this._max; }
    set max(v: number) { this._max = v; this._updateThumbPosition(); }

    get onChange(): ((value: number) => void) | null { return this._onChange; }
    set onChange(v: ((value: number) => void) | null) { this._onChange = v; }

    private _updateFromMouse(e: MouseEvent): void {
        const rect = this._dom.getBoundingClientRect();
        let ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

        let val = this._min + ratio * (this._max - this._min);
        if (this._step > 0) {
            val = Math.round(val / this._step) * this._step;
        }
        this._value = Math.max(this._min, Math.min(this._max, val));
        this._updateThumbPosition();
        if (this._onChange) this._onChange(this._value);
    }

    private _updateThumbPosition(): void {
        const range = this._max - this._min;
        const ratio = range > 0 ? (this._value - this._min) / range : 0;
        this._thumbDom.style.left = (ratio * 100) + '%';
    }
}

// --- UIDropdown ---

export class UIDropdown extends UIElement {
    private _options: { value: string; label: string }[] = [];
    private _selected: string = '';
    private _onChange: ((value: string) => void) | null = null;
    private _selectEl: HTMLSelectElement;

    constructor(options?: UIDropdownOptions) {
        super('div');
        this._dom.style.pointerEvents = 'auto';

        this._selectEl = document.createElement('select');
        this._selectEl.style.cssText = `
            width: 100%; height: 100%; box-sizing: border-box;
            background: rgba(0,0,0,0.6); border: 1px solid #666;
            color: ${options?.color ?? 'white'}; font-family: monospace;
            font-size: ${options?.fontSize ?? 14}px; padding: 4px 8px;
            border-radius: 4px; outline: none; cursor: pointer;
        `;

        if (options?.options) {
            this._options = options.options.map(o =>
                typeof o === 'string' ? { value: o, label: o } : o
            );
            this._buildOptions();
        }
        if (options?.selected) {
            this._selected = options.selected;
            this._selectEl.value = options.selected;
        }
        if (options?.onChange) this._onChange = options.onChange;

        this._selectEl.addEventListener('change', () => {
            this._selected = this._selectEl.value;
            if (this._onChange) this._onChange(this._selected);
        });

        this._dom.appendChild(this._selectEl);
        if (options) this._applyBaseOptions(options);
        else this._applyPosition();
    }

    get selected(): string { return this._selected; }
    set selected(v: string) { this._selected = v; this._selectEl.value = v; }

    get options(): { value: string; label: string }[] { return this._options; }
    set options(v: { value: string; label: string }[]) { this._options = v; this._buildOptions(); }

    get onChange(): ((value: string) => void) | null { return this._onChange; }
    set onChange(v: ((value: string) => void) | null) { this._onChange = v; }

    private _buildOptions(): void {
        this._selectEl.innerHTML = '';
        for (const opt of this._options) {
            const el = document.createElement('option');
            el.value = opt.value;
            el.textContent = opt.label;
            this._selectEl.appendChild(el);
        }
        if (this._selected) this._selectEl.value = this._selected;
    }
}

// --- UIGrid ---

export class UIGrid extends UIElement {
    _children: Set<UIElement> = new Set();
    private _columns: number = 3;
    private _cellWidth: number = 0;
    private _cellHeight: number = 0;
    private _gap: number = 4;

    constructor(options?: UIGridOptions) {
        super('div');
        this._dom.style.display = 'grid';

        this._columns = options?.columns ?? 3;
        this._cellWidth = options?.cellWidth ?? 0;
        this._cellHeight = options?.cellHeight ?? 0;
        this._gap = options?.gap ?? 4;

        this._updateGridTemplate();

        if (options) this._applyBaseOptions(options);
        else this._applyPosition();
    }

    get columns(): number { return this._columns; }
    set columns(v: number) { this._columns = v; this._updateGridTemplate(); }

    get cellWidth(): number { return this._cellWidth; }
    set cellWidth(v: number) { this._cellWidth = v; this._updateGridTemplate(); }

    get cellHeight(): number { return this._cellHeight; }
    set cellHeight(v: number) { this._cellHeight = v; this._updateGridTemplate(); }

    get gap(): number { return this._gap; }
    set gap(v: number) { this._gap = v; this._dom.style.gap = v + 'px'; }

    addChild(child: UIElement): void {
        if (child._parent) {
            (child._parent as any)._children?.delete(child);
        } else if (child._dom.parentNode) {
            child._dom.parentNode.removeChild(child._dom);
        }
        child._parent = null;
        this._children.add(child);
        this._dom.appendChild(child._dom);
    }

    removeChild(child: UIElement): void {
        if (!this._children.has(child)) return;
        this._children.delete(child);
        if (child._dom.parentNode === this._dom) {
            this._dom.removeChild(child._dom);
        }
    }

    clearChildren(): void {
        for (const child of this._children) {
            if (child._dom.parentNode === this._dom) {
                this._dom.removeChild(child._dom);
            }
        }
        this._children.clear();
    }

    destroy(): void {
        for (const child of this._children) child.destroy();
        this._children.clear();
        super.destroy();
    }

    private _updateGridTemplate(): void {
        const col = this._cellWidth > 0
            ? `repeat(${this._columns}, ${this._cellWidth}px)`
            : `repeat(${this._columns}, 1fr)`;
        this._dom.style.gridTemplateColumns = col;
        if (this._cellHeight > 0) {
            this._dom.style.gridAutoRows = this._cellHeight + 'px';
        }
        this._dom.style.gap = this._gap + 'px';
    }
}

// --- Tooltip ---

export function attachTooltip(element: UIElement, options: UITooltipOptions): void {
    const tipEl = document.createElement('div');
    tipEl.style.cssText = `
        position: fixed; padding: 4px 8px; border-radius: 4px;
        font-family: monospace; font-size: ${options.fontSize ?? 12}px;
        color: ${options.color ?? 'white'};
        background: ${options.backgroundColor ?? 'rgba(0,0,0,0.85)'};
        pointer-events: none; z-index: 100000; display: none;
        white-space: nowrap;
    `;
    tipEl.textContent = options.text ?? '';
    document.body.appendChild(tipEl);

    let showTimer: number = 0;
    const delay = options.delay ?? 500;

    element._dom.addEventListener('mouseenter', (e: MouseEvent) => {
        showTimer = window.setTimeout(() => {
            tipEl.style.display = '';
            tipEl.style.left = e.clientX + 10 + 'px';
            tipEl.style.top = e.clientY + 10 + 'px';
        }, delay);
    });
    element._dom.addEventListener('mousemove', (e: MouseEvent) => {
        tipEl.style.left = e.clientX + 10 + 'px';
        tipEl.style.top = e.clientY + 10 + 'px';
    });
    element._dom.addEventListener('mouseleave', () => {
        clearTimeout(showTimer);
        tipEl.style.display = 'none';
    });
}

// --- GameUISystem ---

export class GameUISystem {
    private _overlay: HTMLElement | null = null;
    private _elements: Set<UIElement> = new Set();
    private _viewportSelector: string;

    constructor(viewportSelector: string = '.viewport-canvas-container') {
        this._viewportSelector = viewportSelector;
    }

    getOverlay(): HTMLElement {
        return this._getOverlayDom();
    }

    createText(options?: UITextOptions): UIText {
        const el = new UIText(options);
        this._addElement(el);
        return el;
    }

    createImage(options?: UIImageOptions): UIImage {
        const el = new UIImage(options);
        this._addElement(el);
        return el;
    }

    createButton(options?: UIButtonOptions): UIButton {
        const el = new UIButton(options);
        this._addElement(el);
        return el;
    }

    createPanel(options?: UIPanelOptions): UIPanel {
        const el = new UIPanel(options);
        this._addElement(el);
        return el;
    }

    createProgressBar(options?: UIProgressBarOptions): UIProgressBar {
        const el = new UIProgressBar(options);
        this._addElement(el);
        return el;
    }

    createTextInput(options?: UITextInputOptions): UITextInput {
        const el = new UITextInput(options);
        this._addElement(el);
        return el;
    }

    createScrollView(options?: UIScrollViewOptions): UIScrollView {
        const el = new UIScrollView(options);
        this._addElement(el);
        return el;
    }

    createSlider(options?: UISliderOptions): UISlider {
        const el = new UISlider(options);
        this._addElement(el);
        return el;
    }

    createDropdown(options?: UIDropdownOptions): UIDropdown {
        const el = new UIDropdown(options);
        this._addElement(el);
        return el;
    }

    createGrid(options?: UIGridOptions): UIGrid {
        const el = new UIGrid(options);
        this._addElement(el);
        return el;
    }

    destroyAll(): void {
        for (const el of this._elements) {
            if (el._dom.parentNode) {
                el._dom.parentNode.removeChild(el._dom);
            }
        }
        this._elements.clear();
        if (this._overlay && this._overlay.parentNode) {
            this._overlay.parentNode.removeChild(this._overlay);
            this._overlay = null;
        }
    }

    /** @internal */
    _getOverlayDom(): HTMLElement {
        if (!this._overlay) {
            this._overlay = document.createElement('div');
            this._overlay.id = 'game-ui-overlay';
            const s = this._overlay.style;
            s.position = 'absolute';
            s.top = '0';
            s.left = '0';
            s.width = '100%';
            s.height = '100%';
            s.pointerEvents = 'none';
            s.zIndex = '10';
            s.overflow = 'hidden';
            const viewport = document.querySelector(this._viewportSelector);
            if (viewport) {
                viewport.appendChild(this._overlay);
            } else {
                document.body.appendChild(this._overlay);
            }
        }
        return this._overlay;
    }

    /** @internal */
    _unregister(el: UIElement): void {
        this._elements.delete(el);
    }

    private _addElement(el: UIElement): void {
        el._system = this;
        this._elements.add(el);
        this._getOverlayDom().appendChild(el._dom);
    }
}
