/**
 * Recursive Descent Parser — transforms token stream into AST.
 *
 * Grammar:
 *   Response     → Block*
 *   Block        → MessageBlock | CommandBlock
 *   MessageBlock → MESSAGE
 *   CommandBlock → BLOCK_OPEN BLOCK_BODY BLOCK_END
 */

import { Token } from './lexer.js';
import { ASTNode, MessageNode, EditNode, ToolCallNode } from './syntax_tree.js';
import { CompileError } from './errors.js';

export function parse(tokens: Token[]): { ast: ASTNode[]; errors: CompileError[] } {
  const ast: ASTNode[] = [];
  const errors: CompileError[] = [];
  let pos = 0;

  function current(): Token | undefined { return tokens[pos]; }
  function advance(): Token { return tokens[pos++]; }
  function expect(type: string): Token | null {
    const t = current();
    if (!t || t.type !== type) {
      errors.push({
        phase: 'parse',
        message: `Expected ${type} but got ${t?.type ?? 'end of input'}`,
        hint: `Check that <<<BLOCK_NAME>>> has matching body and <<<END>>>`,
        location: t?.location,
      });
      return null;
    }
    return advance();
  }

  while (pos < tokens.length) {
    const tok = current()!;

    // Skip BARE_TEXT tokens (already reported as lex errors)
    if (tok.type === 'BARE_TEXT') { advance(); continue; }

    // ── Message block ──
    if (tok.type === 'MESSAGE') {
      advance();
      ast.push({ kind: 'message', text: tok.value } as MessageNode);
      continue;
    }

    // ── Command block ──
    if (tok.type === 'BLOCK_OPEN') {
      const openTok = advance();
      const bodyTok = expect('BLOCK_BODY');
      expect('BLOCK_END');

      if (!bodyTok || !openTok.name) continue;

      switch (openTok.name) {
        case 'EDIT': {
          const code = bodyTok.value.trim();
          if (!code) {
            errors.push({
              phase: 'parse',
              message: 'EDIT: empty code block',
              hint: 'Write JavaScript code using the scene API. Example: scene.addEntity("Cube", "cube", {position: {x:0, y:1, z:0}})',
              location: bodyTok.location,
            });
            break;
          }
          ast.push({ kind: 'edit', code } as EditNode);
          break;
        }

        default: {
          // All other valid block names are tool calls
          // Args can come from tag attributes (<<<NAME key="val">>>) or body JSON (<<<NAME>>>{"key":"val"}<<<END>>>)
          let args = openTok.args || {};
          if (Object.keys(args).length === 0 && bodyTok.value.trim()) {
            try {
              const parsed = JSON.parse(bodyTok.value.trim());
              if (typeof parsed === 'object' && !Array.isArray(parsed)) {
                args = parsed;
              }
            } catch { /* body is not JSON — leave args empty */ }
          }
          ast.push({
            kind: 'tool_call',
            name: openTok.name,
            args,
            body: bodyTok.value,
          } as ToolCallNode);
          break;
        }
      }
      continue;
    }

    // Unexpected token
    errors.push({
      phase: 'parse',
      message: `Unexpected token: ${tok.type}`,
      hint: 'Response should be { message } or <<<BLOCK_NAME>>>body<<<END>>>',
      location: tok.location,
    });
    advance();
  }

  return { ast, errors };
}
