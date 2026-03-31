/**
 * Parses class-level property declarations from GameScript source.
 * Extracts property name, type, and default value for the editor inspector.
 * Type is determined strictly from the default value — no guessing from names.
 *
 * Example:
 *   class PlayerController extends GameScript {
 *       speed = 5;
 *       playerName = "Hero";
 *       isActive = true;
 *       color = [1, 0, 0, 1];
 *   }
 *
 * Result:
 *   [
 *     { name: 'speed', type: 'number', default: 5 },
 *     { name: 'playerName', type: 'string', default: 'Hero' },
 *     { name: 'isActive', type: 'boolean', default: true },
 *     { name: 'color', type: 'color', default: [1, 0, 0, 1] },
 *   ]
 */

export interface ScriptPropertyDef {
  name: string;
  type: 'number' | 'string' | 'boolean' | 'color';
  default: any;
}

const INTERNAL_PROPS = new Set([
  'entity', 'transform', 'scene', 'time', 'input', 'ui', 'audio',
  'console', 'rigidbody', 'collider',
]);

export function parseScriptProperties(source: string): ScriptPropertyDef[] {
  const props: ScriptPropertyDef[] = [];

  const classMatch = source.match(/class\s+\w+\s+extends\s+GameScript\s*\{/);
  if (!classMatch) return props;

  const classStart = classMatch.index! + classMatch[0].length;

  // Find matching closing brace
  let depth = 1;
  let classEnd = classStart;
  for (let i = classStart; i < source.length && depth > 0; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') depth--;
    if (depth === 0) { classEnd = i; break; }
  }

  const classBody = source.slice(classStart, classEnd);
  const lines = classBody.split('\n');
  let braceDepth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*')) continue;

    for (const ch of trimmed) {
      if (ch === '{') braceDepth++;
      else if (ch === '}') braceDepth--;
    }

    // Skip lines inside method bodies
    if (braceDepth > 0 && !trimmed.match(/^[\w$]+\s*=\s*/)) continue;
    if (braceDepth > 1) continue;

    // Match property declarations: name = value;
    const propMatch = trimmed.match(/^([\w$]+)\s*=\s*(.+?)\s*;?\s*$/);
    if (!propMatch) continue;

    const [, name, defaultStr] = propMatch;

    if (INTERNAL_PROPS.has(name)) continue;
    if (name.startsWith('_')) continue;
    if (/^\(/.test(defaultStr) || /^function/.test(defaultStr)) continue;
    if (/^\([^)]*\)\s*=>/.test(defaultStr) || /^[\w]+\s*=>/.test(defaultStr)) continue;

    const value = defaultStr.trim();

    if (/^-?\d+(\.\d+)?$/.test(value)) {
      props.push({ name, type: 'number', default: parseFloat(value) });
    } else if (value === 'true' || value === 'false') {
      props.push({ name, type: 'boolean', default: value === 'true' });
    } else if (/^["'].*["']$/.test(value)) {
      props.push({ name, type: 'string', default: value.slice(1, -1) });
    } else if (value.startsWith('[')) {
      try {
        const arr = JSON.parse(value);
        if (Array.isArray(arr) && arr.length >= 3 && arr.every(v => typeof v === 'number')) {
          props.push({ name, type: 'color', default: arr });
        }
      } catch {
        // Not valid JSON — skip
      }
    }
  }

  return props;
}
