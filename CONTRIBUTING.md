# Contributing to ParallaxPro

Thanks for your interest in contributing! ParallaxPro is an open-source 3D game engine with an AI assistant, and we welcome contributions of all kinds.

## Ways to Contribute

- **Bug reports** — found something broken? Open an issue
- **Game templates** — create new game templates that others can use
- **Engine features** — renderer, physics, scripting, editor UI
- **AI improvements** — better prompts, new tool calls, smarter routing
- **Documentation** — improve the README, add examples, write guides
- **Bug fixes** — pick an open issue and submit a PR

## Getting Started

1. Fork the repo and clone it locally
2. Follow the [Run Locally](README.md#run-locally) instructions to get the engine running
3. Make your changes on a new branch
4. Test locally to make sure nothing breaks
5. Submit a pull request

## Project Structure

```
engine/
  backend/
    src/
      server.ts                    — Express + WebSocket server
      config.ts                    — Environment configuration
      plugin.ts                    — Plugin interface for hosted extensions
      middleware/auth.ts           — JWT authentication
      routes/projects.ts           — Project CRUD API
      routes/assets.ts             — Asset browsing API
      db/                          — SQLite schema + connection
      ws/
        editor_ws.ts               — WebSocket handler, LLM orchestration
        services/
          llm.ts                   — LLM streaming client
          chat_protocol.ts         — System prompt + tool definitions
          chat_log.ts              — Chat logging
        llm_compiler/
          lexer.ts                 — Tokenizes AI response into blocks
          parser.ts                — Parses tokens into AST
          semantic_analyzer.ts     — Validates AST against project state
          executor.ts              — Executes validated AST
          scene_script_executor.ts — EDIT block runtime (scene manipulation)
        services/pipeline/
          template_loader.ts       — Discovers + loads game templates
          template_validator.ts    — Validates templates at startup
          level_assembler.ts       — Builds scenes from templates
          cli_fixer.ts             — Spawns CLI agent to fix game bugs
    reusable_game_components/
      game_templates/v0.1/         — Game templates (4-file format)
      behaviors/v0.1/              — Per-entity behavior scripts
      systems/v0.1/                — Multi-entity system scripts
      ui/v0.1/                     — HTML UI overlays
  frontend/
    editor/src/
      main.ts                      — App entry point
      editor_context.ts            — Core editor state + scene management
      backend/backend_client.ts    — REST + WebSocket API client
      toolbar/toolbar.ts           — Top toolbar (play, publish, settings)
      panels/                      — UI panels (hierarchy, properties, chat, assets)
      views/                       — Project list + editor views
    runtime/function/
      scripting/script_system.ts   — Script execution engine
      physics/physics_system.ts    — Rapier physics wrapper
      render/                      — WebGPU renderer
      ui/html_ui_manager.ts        — HTML iframe overlay system
```

## Game Templates

Templates use a 4-file format in `game_templates/v0.1/{template_name}/`:

| File | Purpose |
|------|---------|
| `01_flow.json` | Hierarchical finite state machine (game states, transitions, UI) |
| `02_entities.json` | Entity definitions with tags, behaviors, and components |
| `03_worlds.json` | Scene layouts (what entities go where) |
| `04_systems.json` | Manager scripts that orchestrate gameplay |

The best way to create a new template is to study an existing one (like `chess/` or `fps_shooter/`) and follow the same patterns. The template validator runs at startup and will catch most errors.

## LLM Compiler

The AI response goes through a full compiler pipeline:

1. **Lexer** — tokenizes the response into text blocks `{ }` and command blocks `<<<NAME>>>...<<<END>>>`
2. **Parser** — builds an AST from the tokens
3. **Semantic Analyzer** — validates the AST against the current project state
4. **Executor** — executes the validated AST (scene edits, template loads, fixer spawns)

If you're modifying how the AI interacts with the engine, this is where to look.

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Test your changes locally before submitting
- If you're adding a new game template, make sure it passes the template validator
- If you're modifying the system prompt or tool definitions, test with a few different game prompts
- Don't include unrelated formatting changes or refactors

## Code Style

- TypeScript throughout (backend and frontend)
- No strict linting rules enforced yet — just match the existing style
- Prefer clarity over cleverness

## Questions?

Join our [Discord](https://discord.gg/GEWEdSaXfd) or open an issue.
