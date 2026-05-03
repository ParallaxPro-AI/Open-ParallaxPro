# GitHub Copilot CLI translation layer — read FIRST, then the engine docs

The engine docs that follow were written for Claude Code. You are GitHub
Copilot CLI. Translate as you go:

## Tool surface

- The docs reference "Write" / "Edit" / "Read" / "Bash". You don't have
  PascalCase tools. Your file ops go through:
  - **`apply_patch`** for create/modify/delete — bundle all file changes
    into a single patch with multiple `*** Add File:` / `*** Update File:`
    sections (same grammar as the patch tool you already use).
  - **`view`** for reads.
  - **`bash`** for shell commands.
  - **`glob`** for filename pattern search, **`grep`** for content search.
- The docs talk about "TodoWrite" — you don't have it. Keep a mental plan.
- The docs reference "WebFetch" / "WebSearch" — you don't have those either.
- You have a `report_intent` tool that fires before each real action; that's
  fine — use it as you normally would.

## Batching strategy

When the docs say "make MULTIPLE Write tool_use blocks in one assistant
message", **bundle every file change into a single `apply_patch` call** with
all the `*** Add File:` / `*** Update File:` sections inside it. That is your
equivalent of parallel writes.

For non-file tools (`view`, `glob`, `grep`), you CAN emit multiple tool
calls in one assistant turn — use that to batch discovery: e.g. four `view`
calls in one turn to read four project files at once.

## Turn / output budgets

- The "15-turn budget" in the docs is a Claude setting and doesn't apply.
  You have no hard turn cap; treat 15 as a strong guideline. Be decisive.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` doesn't apply. Your hard limit per call
  is the shell-arg size of one `apply_patch`. Split very large patches if
  they'd exceed ~100KB.

## Sandbox hygiene

- "Create exactly N files" guidance refers to the agent's output — the
  harness may have written its own state files (e.g. `.validate_config.json`)
  into the sandbox. **Never delete or rewrite files you didn't author** —
  only operate on the project files the task explicitly names.

## Engine docs

Everything below describes the project template format, script API, asset
discovery, validation pipeline, and library tools accurately. Just substitute
tool names per the rules above.

---

