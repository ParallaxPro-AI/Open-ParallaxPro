/**
 * Lexer — tokenizes AI response into typed tokens.
 *
 * Token types:
 *   MESSAGE       — { text }
 *   BLOCK_OPEN    — <<<NAME args>>>
 *   BLOCK_BODY    — content between open and <<<END>>>
 *   BLOCK_END     — <<<END>>>
 *   BARE_TEXT     — anything not inside a block (ERROR)
 */

import { Scanner } from './scanner.js';
import { CompileError, SourceLocation } from './errors.js';
import { VALID_BLOCK_NAMES } from './schemas.js';

export type TokenType = 'MESSAGE' | 'BLOCK_OPEN' | 'BLOCK_BODY' | 'BLOCK_END' | 'BARE_TEXT';

export interface Token {
  type: TokenType;
  value: string;
  name?: string;              // For BLOCK_OPEN: the block name
  args?: Record<string, string>; // For BLOCK_OPEN: parsed args
  location: SourceLocation;
}

function parseTagArgs(argsStr: string): Record<string, string> {
  const args: Record<string, string> = {};
  const regex = /(\w+)=(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = regex.exec(argsStr)) !== null) {
    args[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }
  return args;
}

export function tokenize(source: string): { tokens: Token[]; errors: CompileError[] } {
  // Strip markdown code fences (``` or ```json etc.) and stray single backticks
  // that LLMs use for inline code formatting. Preserve backticks inside
  // <<<EDIT>>> blocks so template literals work.
  const editBlockBodies: string[] = [];
  source = source.replace(/<<<EDIT>>>([\s\S]*?)<<<END>>>/g, (_m, body) => {
    const idx = editBlockBodies.length;
    editBlockBodies.push(body);
    return `<<<EDIT>>>__EDIT_BLOCK_${idx}__<<<END>>>`;
  });
  source = source.replace(/`/g, '');
  source = source.replace(/__EDIT_BLOCK_(\d+)__/g, (_m, idx) => editBlockBodies[parseInt(idx)]);
  const scanner = new Scanner(source);
  const tokens: Token[] = [];
  const errors: CompileError[] = [];

  while (!scanner.done) {
    scanner.skipWhitespace();
    if (scanner.done) break;

    const loc = scanner.location();

    // ── Message block: { ... } ──
    if (scanner.peek() === '{') {
      const content = scanner.readBraceBlock();
      if (content === null) {
        errors.push({ phase: 'lex', message: 'Unclosed message block { }', hint: 'Every { must have a matching }. Ensure no unescaped { } inside your message.', location: loc });
        break;
      }
      tokens.push({ type: 'MESSAGE', value: content.trim(), location: loc });
      continue;
    }

    // ── Block tag: <<<NAME args>>> ──
    if (scanner.startsWith('<<<')) {
      const tagMatch = scanner.remaining.match(/^<<<(\w+)((?:\s+\w+=(?:"[^"]*"|'[^']*'))*)>{1,3}/);
      if (!tagMatch) {
        errors.push({ phase: 'lex', message: 'Malformed block tag starting with <<<', hint: 'Tags must be: <<<NAME>>> or <<<NAME arg="value">>>. Use triple angle brackets >>>.', location: loc });
        scanner.advance(3);
        continue;
      }

      const name = tagMatch[1];
      const argsStr = tagMatch[2] || '';
      scanner.advance(tagMatch[0].length);

      if (!VALID_BLOCK_NAMES.has(name)) {
        errors.push({
          phase: 'lex',
          message: `Unknown block name "${name}"`,
          hint: `Valid blocks: ${[...VALID_BLOCK_NAMES].join(', ')}.`,
          location: loc,
        });
        const endIdx = scanner.remaining.indexOf('<<<END>>>');
        if (endIdx >= 0) scanner.advance(endIdx + 9);
        continue;
      }

      const args = parseTagArgs(argsStr);
      tokens.push({
        type: 'BLOCK_OPEN',
        value: tagMatch[0],
        name,
        args,
        location: loc,
      });

      // Read body until <<<END>>>
      const bodyLoc = scanner.location();
      const body = scanner.readUntil('<<<END>>>');
      if (body === null) {
        errors.push({ phase: 'lex', message: `Missing <<<END>>> for <<<${name}>>>`, hint: `Every <<<${name}>>> must be closed with <<<END>>>`, location: loc });
        break;
      }

      const cleanBody = body.trim();

      if (/>{1,3}$/.test(cleanBody)) {
        errors.push({ phase: 'lex', message: `<<<${name}>>>: body has trailing ">" before <<<END>>>`, hint: `Do not write >>> before <<<END>>>. Just end the body and write <<<END>>> directly.`, location: bodyLoc });
      }

      if (/^```/.test(cleanBody) || /```$/.test(cleanBody)) {
        errors.push({ phase: 'lex', message: `<<<${name}>>>: body contains markdown code fences`, hint: 'Do not wrap block body in ```. Write the JSON directly.', location: bodyLoc });
      }

      tokens.push({ type: 'BLOCK_BODY', value: cleanBody, location: bodyLoc });
      scanner.consume('<<<END>>>');
      tokens.push({ type: 'BLOCK_END', value: '<<<END>>>', location: scanner.location() });
      continue;
    }

    // ── Bare text (COMPILE ERROR) ──
    let bareEnd = scanner.offset;
    const src = scanner.remaining;
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '{' || src.startsWith('<<<', i)) { bareEnd = scanner.offset + i; break; }
      if (i === src.length - 1) bareEnd = scanner.offset + src.length;
    }
    const bareText = source.slice(scanner.offset, bareEnd).trim();
    if (bareText.length > 0) {
      const isBacktick = /^`+$/.test(bareText);
      errors.push({
        phase: 'lex',
        message: `Bare text not wrapped in any block: "${bareText.slice(0, 100)}${bareText.length > 100 ? '...' : ''}"`,
        hint: isBacktick
          ? 'Do NOT use backticks (`) around blocks. Write <<<EDIT>>> directly, not `<<<EDIT>>>`. Remove all backtick characters.'
          : 'Wrap ALL text inside { } blocks. Example: {Your message here.}',
        location: loc,
      });
      tokens.push({ type: 'BARE_TEXT', value: bareText, location: loc });
    }
    scanner.advance(bareEnd - scanner.offset);
  }

  return { tokens, errors };
}
