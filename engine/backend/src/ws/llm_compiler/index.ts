/**
 * AI Response Compiler — public API.
 *
 * Pipeline: Source → Scanner → Lexer → Parser → Semantic Analyzer → Result
 *
 * If compilation succeeds, the AST is guaranteed to be valid and can be
 * executed without any normalization or error handling.
 *
 * If compilation fails, errors are returned with fix suggestions.
 * The AI must fix ALL errors and resubmit.
 */

import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { analyze } from './semantic_analyzer.js';
import { CompileError, formatErrors } from './errors.js';
import { ASTNode } from './syntax_tree.js';

export { formatErrors } from './errors.js';
export { execute } from './executor.js';
export type { ExecutionContext, ExecutionResult } from './executor.js';
export type { ASTNode } from './syntax_tree.js';
export type { CompileError } from './errors.js';

export interface CompileResult {
  success: boolean;
  ast: ASTNode[];
  errors: CompileError[];
}

/**
 * Compile an AI response.
 * @param source Raw AI response text
 * @param projectData Optional current project data for symbol table (entity references)
 */
export function compile(source: string, projectData?: any): CompileResult {
  const trimmed = source.trim();
  if (!trimmed) {
    return {
      success: false,
      ast: [],
      errors: [{ phase: 'scan', message: 'Empty response', hint: 'Respond with at least: {Your message}' }],
    };
  }

  // Phase 1: Lexical analysis (tokenization)
  const { tokens, errors: lexErrors } = tokenize(trimmed);

  // Phase 2: Parsing (token stream → AST)
  const { ast, errors: parseErrors } = parse(tokens);

  // Phase 3: Semantic analysis
  const semanticErrors = analyze(ast);

  // Collect all errors
  const allErrors = [...lexErrors, ...parseErrors, ...semanticErrors];

  return {
    success: allErrors.length === 0,
    ast,
    errors: allErrors,
  };
}
