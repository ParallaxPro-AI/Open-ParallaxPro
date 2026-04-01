/**
 * Abstract Syntax Tree node types.
 * The parser produces these, the semantic analyzer validates them.
 */

export type ASTNode =
  | MessageNode
  | EditNode
  | ToolCallNode;

export interface MessageNode {
  kind: 'message';
  text: string;
}

export interface EditNode {
  kind: 'edit';
  code: string;
}

export interface ToolCallNode {
  kind: 'tool_call';
  name: string;
  args: Record<string, string>;
  body: string;
}
