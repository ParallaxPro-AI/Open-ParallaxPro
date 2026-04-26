/**
 * Static analysis: detect HUD panels that visually overlap each other when
 * shown together during gameplay. Used by:
 *   - the `hud_panels_no_overlap` playtest invariant (gates CREATE_GAME output)
 *   - the audit_hud_overlap_cli (sweeps every shipped template)
 *
 * Strict mode: only fires when two panels share an anchor corner AND their
 * bounding-boxes geometrically intersect (using explicit CSS width/height
 * when present, conservative defaults otherwise). Top-/bottom-center pairs
 * compare on the y-axis only since x is viewport-relative.
 */
type Anchor = 'TL' | 'TR' | 'BL' | 'BR' | 'TC' | 'BC';

export interface PanelBox {
  /** UI ref this came from, e.g. `hud/end_turn_btn`. */
  ref: string;
  /** CSS selector inside the HTML for diagnostic output. */
  selector: string;
  anchor: Anchor;
  /** Local-corner coordinates: distance from the anchor corner (px). */
  x0: number; x1: number; y0: number; y1: number;
  /** Whether the size came from explicit CSS or fallback estimate. */
  sizeExact: boolean;
}

export interface Overlap {
  state: string;
  a: PanelBox;
  b: PanelBox;
  reason: string;
}

const NUM_RE = /(-?\d+(?:\.\d+)?)\s*px/i;
function px(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = value.match(NUM_RE);
  return m ? Number(m[1]) : undefined;
}
function getProp(decls: string, name: string): string | undefined {
  const re = new RegExp(`(?:^|[;{\\s])${name}\\s*:\\s*([^;]+?)(?:;|$)`, 'i');
  const m = decls.match(re);
  return m ? m[1].trim() : undefined;
}

function parsePaddingY(value: string | undefined): number {
  if (!value) return 0;
  const parts = value.split(/\s+/).map((p) => Number(p.match(NUM_RE)?.[1] ?? NaN));
  if (parts.some(Number.isNaN)) return 0;
  // shorthand: 1=all, 2=v|h, 3=t|h|b, 4=t|r|b|l
  if (parts.length === 1) return parts[0] * 2;
  if (parts.length === 2) return parts[0] * 2;
  if (parts.length >= 3) return parts[0] + parts[2];
  return 0;
}

/** Extract every `position: fixed` rule from a HUD html file. */
export function parseFixedBoxes(ref: string, html: string): PanelBox[] {
  const styleM = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!styleM) return [];
  // Strip /* ... */ comments before tokenising — otherwise they get glued
  // onto the next selector and pollute diagnostic output.
  const css = styleM[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const out: PanelBox[] = [];
  const ruleRe = /([^{}]+)\{([^{}]+)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ruleRe.exec(css))) {
    const selector = m[1].trim().replace(/\s+/g, ' ');
    const decls = m[2];
    if (!/position\s*:\s*fixed/i.test(decls)) continue;
    const top = px(getProp(decls, 'top'));
    const bottom = px(getProp(decls, 'bottom'));
    const left = px(getProp(decls, 'left'));
    const right = px(getProp(decls, 'right'));
    const transform = getProp(decls, 'transform') ?? '';
    // left:50% with translateX(-50%) → centered. Match string form too.
    const leftRaw = getProp(decls, 'left');
    const rightRaw = getProp(decls, 'right');
    const isCenterX =
      (leftRaw === '50%' && /translateX\(-50%\)/i.test(transform)) ||
      (leftRaw === '50%' && rightRaw === '50%');

    let anchor: Anchor;
    if (isCenterX && top !== undefined) anchor = 'TC';
    else if (isCenterX && bottom !== undefined) anchor = 'BC';
    else if (top !== undefined && left !== undefined && right === undefined && bottom === undefined) anchor = 'TL';
    else if (top !== undefined && right !== undefined && left === undefined && bottom === undefined) anchor = 'TR';
    else if (bottom !== undefined && left !== undefined && right === undefined && top === undefined) anchor = 'BL';
    else if (bottom !== undefined && right !== undefined && left === undefined && top === undefined) anchor = 'BR';
    else continue;

    const wExplicit = px(getProp(decls, 'width'));
    const minW = px(getProp(decls, 'min-width'));
    const hExplicit = px(getProp(decls, 'height'));
    const padY = parsePaddingY(getProp(decls, 'padding'));
    const fontPx = px(getProp(decls, 'font-size')) ?? 14;
    const lineH = (px(getProp(decls, 'line-height')) ?? Math.round(fontPx * 1.4));

    const w = wExplicit ?? minW ?? 80;
    const h = hExplicit ?? Math.max(28, padY + lineH);
    const sizeExact = wExplicit !== undefined && hExplicit !== undefined;

    let x0 = 0, x1 = 0, y0 = 0, y1 = 0;
    switch (anchor) {
      case 'TL': x0 = left!; x1 = left! + w; y0 = top!; y1 = top! + h; break;
      case 'TR': x0 = right!; x1 = right! + w; y0 = top!; y1 = top! + h; break;
      case 'BL': x0 = left!; x1 = left! + w; y0 = bottom!; y1 = bottom! + h; break;
      case 'BR': x0 = right!; x1 = right! + w; y0 = bottom!; y1 = bottom! + h; break;
      case 'TC': x0 = -w / 2; x1 = w / 2; y0 = top!; y1 = top! + h; break;
      case 'BC': x0 = -w / 2; x1 = w / 2; y0 = bottom!; y1 = bottom! + h; break;
    }
    out.push({ ref, selector, anchor, x0, x1, y0, y1, sizeExact });
  }
  return out;
}

function intersect1D(a0: number, a1: number, b0: number, b1: number): boolean {
  return Math.min(a1, b1) - Math.max(a0, b0) > 0;
}

/** Pairwise overlap inside one set of simultaneously-visible panels. */
export function findOverlapsInState(state: string, boxes: PanelBox[]): Overlap[] {
  const out: Overlap[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.ref === b.ref) continue;        // same panel — internal layout is its own concern
      if (a.anchor !== b.anchor) continue;  // different corners can't collide statically
      const yOverlap = intersect1D(a.y0, a.y1, b.y0, b.y1);
      // For centered anchors, x is viewport-relative — y-overlap alone is sufficient
      // since both x-spans straddle screen-center and any non-trivial widths overlap.
      if (a.anchor === 'TC' || a.anchor === 'BC') {
        if (yOverlap) out.push({ state, a, b, reason: `both ${a.anchor} with overlapping y-range` });
        continue;
      }
      const xOverlap = intersect1D(a.x0, a.x1, b.x0, b.x1);
      if (xOverlap && yOverlap) {
        out.push({ state, a, b, reason: `both ${a.anchor} with intersecting bounding boxes` });
      }
    }
  }
  return out;
}

/** Walk the flow tree and return the set of `show_ui:` refs that are visible
 * during each gameplay-ish leaf state. Excludes menus, lobbies, victory/defeat
 * overlays, pause menus, and game_over screens — those are full-screen takeovers
 * where overlap with HUD panels doesn't matter (the HUD is hidden or covered). */
export function gatherGameplayUI(flow: any): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!flow?.states) return out;
  const EXCLUDE_RE = /^(boot|main_menu|lobby|loading|game_over|victory|defeat|paused|pause)/i;
  type Frame = { name: string; def: any; inheritedShown: Set<string> };
  const stack: Frame[] = [];
  for (const [name, def] of Object.entries<any>(flow.states)) {
    stack.push({ name, def, inheritedShown: new Set() });
  }
  while (stack.length) {
    const f = stack.pop()!;
    if (EXCLUDE_RE.test(f.name)) continue;
    const shown = new Set(f.inheritedShown);
    for (const a of (f.def?.on_enter ?? [])) {
      if (typeof a !== 'string') continue;
      const m = a.match(/^show_ui:(.+)$/);
      if (m) shown.add(m[1].trim());
    }
    if (f.def?.substates && Object.keys(f.def.substates).length > 0) {
      for (const [sname, sdef] of Object.entries<any>(f.def.substates)) {
        stack.push({ name: sname, def: sdef, inheritedShown: shown });
      }
    } else {
      // leaf state — record final shown set
      out.set(f.name, shown);
    }
  }
  return out;
}

/** Resolve a flow ref like `hud/end_turn_btn` to a key into a html-map. The
 * map keys may be relative to the project (`ui/hud/end_turn_btn.html`) or
 * just the ref+`.html` (`hud/end_turn_btn.html`) — we try both. */
export function resolveRefHtml(ref: string, htmls: Record<string, string>): string | null {
  const candidates = [ref, `${ref}.html`, `ui/${ref}`, `ui/${ref}.html`];
  for (const c of candidates) if (htmls[c] !== undefined) return htmls[c];
  return null;
}

/** Top-level entrypoint: given a flow + map of html files, return all overlaps. */
export function analyzeFlow(
  flow: any,
  htmls: Record<string, string>,
): Overlap[] {
  const stateUI = gatherGameplayUI(flow);
  const out: Overlap[] = [];
  for (const [state, refs] of stateUI) {
    const boxes: PanelBox[] = [];
    for (const ref of refs) {
      const html = resolveRefHtml(ref, htmls);
      if (html === null) continue;
      boxes.push(...parseFixedBoxes(ref, html));
    }
    out.push(...findOverlapsInState(state, boxes));
  }
  return out;
}
