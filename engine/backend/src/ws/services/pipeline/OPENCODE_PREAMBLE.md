# OpenCode translation layer — read FIRST, then the engine docs below

The engine docs that follow were written for Claude Code. You are OpenCode.
The structure is mostly compatible — you DO support multiple parallel
`tool_use` blocks per turn — but a few naming differences matter.

## Tool surface

- The docs reference "Write" / "Edit" / "Read" / "Bash" / "Glob" / "Grep" /
  "TodoWrite" / "WebFetch" / "WebSearch" (PascalCase, Claude convention).
  Your tool names are the same set but **lowercase**: `write`, `edit`,
  `read`, `bash`, `glob`, `grep`, `todowrite`, `webfetch`, `websearch`.
  Treat the PascalCase references as direct equivalents.
- "MultiEdit" — you don't have a separate MultiEdit; use multiple `edit`
  calls in one turn instead.

## Batching — embrace parallelism

The docs' core efficiency rule is: **emit MULTIPLE `tool_use` blocks in a
single assistant turn** instead of N sequential turns. This applies to you
verbatim. When the docs say "parallel Write batches", emit several `write`
tool calls in the same turn. Same for batched `read`s during discovery.

You also have a `steps` budget set in `opencode.json` (`agent.build.steps`).
If a run looks expensive, prefer fewer, bigger turns over many small ones.

## Turn / output budgets

- The "15-turn budget" in the docs maps to your `agent.build.steps` setting,
  which the harness sets to 20. Don't waste them on exploration that could
  have been one batched `read`.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` doesn't apply. Your per-message cap is set
  by the model and provider. If a single huge file write would exceed it,
  split into two `write` calls in the same turn.

## Sandbox hygiene

- The harness may have redirected its own state files (e.g. `.validate_config.json`,
  `opencode.json`) into the sandbox. **Never delete or rewrite files you
  didn't author** — only operate on the project files the task explicitly
  names.

## Engine docs

Everything below describes the project template format, script API, asset
discovery, validation pipeline, and library tools accurately. Just substitute
lowercase tool names per the rules above.

---

