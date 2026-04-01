/**
 * Scanner — character-level reading with position tracking.
 * Provides line/column info for error messages.
 */

import { SourceLocation } from './errors.js';

export class Scanner {
  private src: string;
  private pos: number = 0;
  private line: number = 1;
  private col: number = 1;

  constructor(source: string) {
    this.src = source;
  }

  get offset(): number { return this.pos; }
  get done(): boolean { return this.pos >= this.src.length; }
  get remaining(): string { return this.src.slice(this.pos); }

  location(): SourceLocation {
    return { offset: this.pos, line: this.line, column: this.col };
  }

  peek(count: number = 1): string {
    return this.src.slice(this.pos, this.pos + count);
  }

  advance(count: number = 1): string {
    const chunk = this.src.slice(this.pos, this.pos + count);
    for (const ch of chunk) {
      if (ch === '\n') { this.line++; this.col = 1; }
      else { this.col++; }
    }
    this.pos += count;
    return chunk;
  }

  /** Skip whitespace, return true if any was skipped */
  skipWhitespace(): boolean {
    const start = this.pos;
    while (!this.done && /\s/.test(this.src[this.pos])) {
      this.advance(1);
    }
    return this.pos > start;
  }

  /** Check if remaining input starts with the given string */
  startsWith(str: string): boolean {
    return this.src.startsWith(str, this.pos);
  }

  /** Read until the given delimiter, return content before it (excluding delimiter) */
  readUntil(delimiter: string): string | null {
    const idx = this.src.indexOf(delimiter, this.pos);
    if (idx === -1) return null;
    const content = this.src.slice(this.pos, idx);
    this.advance(idx - this.pos);
    return content;
  }

  /** Consume the given string if it matches, return true if consumed */
  consume(str: string): boolean {
    if (this.startsWith(str)) {
      this.advance(str.length);
      return true;
    }
    return false;
  }

  /** Read a brace-balanced block starting with { and ending with } */
  readBraceBlock(): string | null {
    if (this.src[this.pos] !== '{') return null;
    let depth = 0;
    const start = this.pos;
    const savedPos = this.pos;
    const savedLine = this.line;
    const savedCol = this.col;
    while (!this.done) {
      const ch = this.src[this.pos];
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { this.advance(1); return this.src.slice(start + 1, this.pos - 1); } }
      // Skip string contents (don't count braces inside strings)
      if (ch === '"') {
        this.advance(1);
        while (!this.done && this.src[this.pos] !== '"') {
          if (this.src[this.pos] === '\\') this.advance(1); // skip escaped char
          this.advance(1);
        }
        if (!this.done) this.advance(1); // closing quote
        continue;
      }
      this.advance(1);
    }
    // Depth-tracked failed (unmatched { inside text like "token '{'")
    // Fall back: find the first } after the opening {
    this.pos = savedPos + 1;
    this.line = savedLine;
    this.col = savedCol + 1;
    while (!this.done) {
      if (this.src[this.pos] === '}') {
        const content = this.src.slice(savedPos + 1, this.pos);
        this.advance(1);
        return content;
      }
      this.advance(1);
    }
    return null; // truly unclosed
  }
}
