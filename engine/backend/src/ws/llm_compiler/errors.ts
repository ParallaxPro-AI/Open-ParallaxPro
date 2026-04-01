/**
 * Compiler error types and formatting.
 */

export interface SourceLocation {
  offset: number;
  line: number;
  column: number;
}

export interface CompileError {
  phase: 'scan' | 'lex' | 'parse' | 'semantic';
  message: string;
  hint: string;
  location?: SourceLocation;
}

export function formatErrors(errors: CompileError[]): string {
  if (errors.length === 0) return '';
  const lines = [`[COMPILE ERRORS] Your response has ${errors.length} error(s) and was NOT executed. Fix ALL errors:\n`];
  for (let i = 0; i < errors.length; i++) {
    const e = errors[i];
    const loc = e.location ? ` (line ${e.location.line}, col ${e.location.column})` : '';
    lines.push(`  ${i + 1}. [${e.phase.toUpperCase()}] ${e.message}${loc}`);
    lines.push(`     FIX: ${e.hint}`);
  }
  // Keep error message compact — rules are in the protocol docs
  return lines.join('\n');
}
