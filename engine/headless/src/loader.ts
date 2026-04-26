import * as fs from 'fs';
import * as path from 'path';

export interface GameFiles {
  flow: any;
  entities: any;
  worlds: any;
  systems: any;
  scripts: Record<string, string>;
  /** Raw HTML of every `ui/**\/*.html` file, keyed by relative path. Exposed
   * for invariants that scan advertised keybinds from HUD text. */
  uiHtmls: Record<string, string>;
  playtest?: string;
  root: string;
}

export function loadGame(gameDir: string): GameFiles {
  const readJSON = (name: string): any => {
    const p = path.join(gameDir, name);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  };

  const scripts: Record<string, string> = {};
  const walk = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, prefix + entry.name + '/');
      else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
        scripts[prefix + entry.name] = fs.readFileSync(full, 'utf-8');
      }
    }
  };
  walk(path.join(gameDir, 'behaviors'), 'behaviors/');
  walk(path.join(gameDir, 'systems'), 'systems/');
  walk(path.join(gameDir, 'scripts'), 'scripts/');
  walk(path.join(gameDir, 'ui'), 'ui/');

  // Separate HTML pass — needed by the advertised-keys invariant which scans
  // HUD text for keybind hints like `<span class="kbd">P</span> pause`.
  const uiHtmls: Record<string, string> = {};
  const walkHtml = (dir: string, prefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walkHtml(full, prefix + entry.name + '/');
      else if (entry.name.endsWith('.html')) uiHtmls[prefix + entry.name] = fs.readFileSync(full, 'utf-8');
    }
  };
  walkHtml(path.join(gameDir, 'ui'), 'ui/');

  // Authored playtest scenarios are DISABLED (2026-04-26). We no longer
  // load any PLAYTEST.ts/.js/playtest.ts/.js the agent may have written —
  // the headless playtest only runs the built-in invariants now. If the
  // agent ships a PLAYTEST file anyway, it's silently ignored.
  const playtestSrc: string | undefined = undefined;

  return {
    flow: readJSON('01_flow.json'),
    entities: readJSON('02_entities.json'),
    worlds: readJSON('03_worlds.json'),
    systems: readJSON('04_systems.json'),
    scripts,
    uiHtmls,
    playtest: playtestSrc,
    root: gameDir,
  };
}

/** Strip TS syntax that `new Function()` can't digest. Mirrors the regexes used
 * in the existing sandbox_validate.ts so behavior is consistent with the current
 * validate.sh step we're replacing. Deliberately narrow — a broader type strip
 * eats into object literals like `{ x: vx, y: vy }` (treating them as `: Type`
 * annotations). The stricter regexes below only target patterns we KNOW are
 * type annotations. */
export function stripForEval(src: string): string {
  return src
    .replace(/^\s*export\s+default\s+/gm, '')
    .replace(/^\s*export\s+/gm, '')
    .replace(/^\s*import\s+.*$/gm, '')
    .replace(/\bconst\b/g, 'var')
    // `var x: Type =` or `let x: Type =` → `var x =`  (declaration only)
    .replace(/(?:var|let)\s+(\w+)\s*:\s*[^=\n;]+?=/g, 'var $1 =')
    // method signatures: `foo(args): ReturnType {` → `foo(args) {`
    .replace(/\)\s*:\s*[A-Za-z_][\w<>[\],\s|&.]*\s*\{/g, ') {')
    // class field type: `_name: string = "";` / `items: any[] = [];`
    //   Only matches when the whole thing is on one line at class body indent.
    //   The `=(?!=)` bit is critical: otherwise we eat into object-literal
    //   properties like `gamePhase: this._x === "day" ? ...` (the `===` looks
    //   like `<name>: <Type>=...` if we're not careful) and leave broken
    //   `gamePhase = == "day"` as output.
    .replace(/^(\s*)(\w+)\s*:\s*[A-Za-z_][\w<>[\],\s|&.]*?\s*=(?!=)\s*/gm, '$1$2 = ');
}
