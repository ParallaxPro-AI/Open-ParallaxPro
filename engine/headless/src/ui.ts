/**
 * Headless UI layer — enough to answer "does the user have a way to interact?"
 * Tracks every createText/Button/Panel/Image/ProgressBar call with id, bbox,
 * text, visibility, onClick handler, and exposes click-by-id / click-at-point /
 * click-by-text probes. This is the mouse-driven side of the playtest, critical
 * for UI-first games (menus, pong, clicker games).
 *
 * The real engine renders these into DOM; here we just store enough state for
 * tests to find and "press" them.
 */
export interface UIElement {
  id: string;
  kind: 'text' | 'button' | 'panel' | 'image' | 'progressBar' | 'textInput' | 'scrollView' | 'slider' | 'dropdown' | 'grid';
  text?: string;
  x: number;
  y: number;
  width: number;
  height: number;
  visible: boolean;
  onClick?: () => void;
  onChange?: (v: any) => void;
  value?: any;
  _raw: any;
}

export class HeadlessUI {
  private elements = new Map<string, UIElement>();
  private nextId = 1;
  private state: Record<string, any> = {};

  private mk(kind: UIElement['kind'], opts: any): UIElement {
    const id = opts?.id ?? `ui_${kind}_${this.nextId++}`;
    const el: UIElement = {
      id,
      kind,
      text: opts?.text,
      x: opts?.x ?? 0,
      y: opts?.y ?? 0,
      width: opts?.width ?? (kind === 'button' ? 120 : 200),
      height: opts?.height ?? (kind === 'button' ? 40 : 24),
      visible: opts?.visible !== false,
      onClick: opts?.onClick,
      onChange: opts?.onChange,
      value: opts?.value,
      _raw: opts,
    };
    this.elements.set(id, el);
    const self = this;
    // Return a proxy-ish handle matching the engine's UI surface (set text,
    // remove, position mutations).
    return new Proxy(el as any, {
      set(target: any, prop: string, value: any) {
        target[prop] = value;
        return true;
      },
      get(target: any, prop: string) {
        if (prop === 'remove') return () => self.elements.delete(id);
        if (prop === 'setText') return (t: string) => { target.text = t; };
        if (prop === 'setVisible') return (v: boolean) => { target.visible = v; };
        return target[prop];
      },
    });
  }

  createText(opts?: any): UIElement { return this.mk('text', opts ?? {}); }
  createButton(opts?: any): UIElement { return this.mk('button', opts ?? {}); }
  createPanel(opts?: any): UIElement { return this.mk('panel', opts ?? {}); }
  createImage(opts?: any): UIElement { return this.mk('image', opts ?? {}); }
  createProgressBar(opts?: any): UIElement { return this.mk('progressBar', opts ?? {}); }
  createTextInput(opts?: any): UIElement { return this.mk('textInput', opts ?? {}); }
  createScrollView(opts?: any): UIElement { return this.mk('scrollView', opts ?? {}); }
  createSlider(opts?: any): UIElement { return this.mk('slider', opts ?? {}); }
  createDropdown(opts?: any): UIElement { return this.mk('dropdown', opts ?? {}); }
  createGrid(opts?: any): UIElement { return this.mk('grid', opts ?? {}); }
  sendState(state: any): void { this.state = { ...this.state, ...state }; }
  getState(): any { return this.state; }

  list(): UIElement[] { return Array.from(this.elements.values()); }
  listVisible(): UIElement[] { return this.list().filter(e => e.visible); }

  findButtonByText(text: string): UIElement | null {
    const lower = text.toLowerCase();
    for (const el of this.elements.values()) {
      if (!el.visible) continue;
      if (el.kind !== 'button') continue;
      if (!el.text) continue;
      if (el.text.toLowerCase().includes(lower)) return el;
    }
    return null;
  }

  findById(id: string): UIElement | null { return this.elements.get(id) ?? null; }

  findAtPoint(x: number, y: number): UIElement | null {
    // Topmost-first: iterate in reverse creation order.
    const all = Array.from(this.elements.values()).reverse();
    for (const el of all) {
      if (!el.visible) continue;
      if (el.kind !== 'button' && el.kind !== 'textInput' && el.kind !== 'slider' && el.kind !== 'dropdown') continue;
      if (x >= el.x && x <= el.x + el.width && y >= el.y && y <= el.y + el.height) return el;
    }
    return null;
  }

  clickElement(el: UIElement): boolean {
    if (!el.visible) return false;
    if (typeof el.onClick === 'function') {
      try { el.onClick(); return true; }
      catch (e) { throw e; }
    }
    return false;
  }
}
