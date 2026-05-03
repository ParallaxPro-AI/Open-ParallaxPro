# Codex translation layer — read FIRST, then the engine docs below

The engine docs that follow were originally written for Claude Code and use
its tool names + conventions. You are Codex. Translate as you go:

## Tool surface

- The docs reference "Write", "Edit", "Read", "Bash" tools — Codex doesn't
  have those names. **Every file create/modify/delete goes through your
  `apply_patch` grammar** (`*** Begin Patch / *** Add File: / *** Update File:
  / *** End Patch`). Reads go through `cat`/`sed`/`head` via your shell.
- The docs talk about "TodoWrite" — you have no such tool. Keep a mental
  plan; don't try to invoke a TodoWrite call that doesn't exist.
- The docs reference "WebFetch" / "WebSearch" — you don't have those either.
  If a step relies on web fetching, fall back to whatever you can derive from
  the local sandbox; only mention the limitation if the user-facing answer
  needs it.

## Batching strategy — your natural advantage

When the docs say "make MULTIPLE Write tool_use blocks in one assistant
message" or "parallel Write batches", **bundle every file change into a
single `apply_patch` call** with multiple `*** Add File:` / `*** Update File:`
sections. That's your equivalent of parallel writes — and it's actually
cheaper than Claude's parallelism because it's one tool call, not N. Don't
fight your model's preferred shape: one big patch beats many small ones.

For shell commands, you can run several non-conflicting commands in one
`bash -lc 'cmd1 && cmd2 && cmd3'` line. Use this for the discovery phase:
`library.sh list && library.sh search "X"`, then a single patch with the
full set of edits.

## Turn / output budgets

- The docs cite a "15-turn budget" — that's a Claude `--max-turns` setting
  and doesn't apply to you. You don't have a hard turn cap, but treat 15 as
  a strong guideline. Be decisive: explore, plan, then patch in one go.
- The docs cite `CLAUDE_CODE_MAX_OUTPUT_TOKENS=100000` — irrelevant. Your
  hard limit is the shell-argument size of one `apply_patch` call. If a
  single patch would exceed ~100KB, split into two `apply_patch` calls
  rather than truncating files.

## Sandbox hygiene

- "Create exactly N files" wording in the docs is *guidance for the agent's
  output*, not an instruction to clean up the sandbox. The harness may have
  redirected its own state files (e.g. `stream.jsonl`, `.validate_config.json`)
  into the sandbox — **never delete or rewrite files you didn't author**.
  Only operate on the explicit set of project files the task names.

## Engine docs

Everything below describes the project template format, script API, asset
discovery, validation pipeline, and library tools accurately. The conventions
apply unchanged to you — just substitute the tool names per the rules above.

---

