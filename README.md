<h1 align="center">
    <a href="https://parallaxpro.ai/">
        <img src="assets/solid_logos/main_logo_horizontal.png" alt="banner"/>
    </a>
</h1>

<p align="center">
    <a href="https://x.com/ParallaxPro_AI">
        <img src="https://img.shields.io/badge/Follow%20on%20X-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X"/>
    </a>
    <a href="https://discord.gg/GEWEdSaXfd">
        <img src="https://img.shields.io/badge/Join%20Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Join Discord"/>
    </a>
    <a href="http://www.youtube.com/@ParallaxPro_AI">
        <img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"/>
    </a>
    <a href="https://www.instagram.com/parallaxpro_ai/">
        <img src="https://img.shields.io/badge/Instagram-E4405F?style=for-the-badge&logo=instagram&logoColor=white" alt="Instagram"/>
    </a>
</p>

<h3 align="center">Open source tool that turns prompts into playable games</h3>

## ParallaxPro

LLMs can generate games, but without a real game engine behind them, those games hit a wall fast -- no real physics, no efficient rendering, no entity-component system, no shadow maps, no collision detection. The AI ends up writing hundreds of lines of hacky code to approximate what any game engine gives you for free.

[ParallaxPro](https://parallaxpro.ai/) is a browser-based 3D game engine where AI generates games that run on a real engine with real infrastructure -- WebGPU rendering, rigid body physics, skeletal animation, and an ECS architecture. The AI doesn't need to reinvent the wheel. It just places entities, attaches scripts, and the engine handles the rest.

- **Fully open source** -- engine, editor, AI prompts, game templates, everything. No hidden black boxes.
- **Royalty-free engine** -- the engine and your game code are yours to distribute. No engine royalties, no attribution required. Monetization tools (microtransactions, etc.) are coming soon — if you opt in to those we may take a cut on them, but the engine itself is always free.
- **No vendor lock-in** -- bring your own LLM (Groq, OpenRouter, Ollama, or any OpenAI-compatible API). Host it yourself or use our cloud.
- **Transparent AI** -- even the system prompts and LLM compiler are open source. See exactly how the AI builds your games.

### Try It Online

The easiest way to use ParallaxPro is at **[parallaxpro.ai](https://parallaxpro.ai/)** -- no setup required. You get the AI assistant, 5000+ 3D assets, game publishing, and everything else out of the box.

https://github.com/user-attachments/assets/eba68cf6-724e-4225-a23e-8b385d5c598c

### Run Locally

**Prerequisites:** Node.js 20+, npm, and **at least one** of the following agent CLIs installed and authenticated (backend refuses to start without one):

- [Claude Code](https://code.claude.com/docs/en/overview)
- [Codex](https://developers.openai.com/codex/cli)
- [OpenCode](https://opencode.ai/) -- works with **any LLM, any provider, even local models** (Claude, GPT, Gemini, Groq, Ollama, LM Studio, you name it)
- [GitHub Copilot CLI](https://github.com/features/copilot/cli)

#### 1. Clone the repo

```bash
git clone https://github.com/ParallaxPro-AI/Open-ParallaxPro.git
cd Open-ParallaxPro
```

#### 2. Start the backend

```bash
cd engine/backend
npm install
npx tsx src/server.ts
```

Serves on `http://localhost:3003`.

#### 3. Start the frontend

In a new terminal:

```bash
cd engine/frontend/editor
npm install
npm run dev
```

Open **http://localhost:5174** in Chrome/Edge (for WebGPU). Type a game idea in the chat and the AI will build it for you.

---

#### Optional configuration

- **Direct LLM API** (recommended for better chat — faster and cleaner than driving a CLI as a chat proxy). Copy `engine/backend/.env.example` to `engine/backend/.env` and set `AI_BASE_URL` / `AI_MODEL` / `AI_API_KEY`. Any OpenAI-compatible provider works:

  | Provider | `AI_BASE_URL` | Example `AI_MODEL` |
  |----------|--------------|-------------------|
  | [Groq](https://console.groq.com/) | `https://api.groq.com/openai/v1` | `llama-3.3-70b-versatile` |
  | [OpenRouter](https://openrouter.ai/) | `https://openrouter.ai/api/v1` | `meta-llama/llama-3.3-70b-instruct` |
  | Local (Ollama) | `http://localhost:11434/v1` | `llama3.3` |

  Without this the backend falls back to whichever agent CLI is installed — works fine for trying things out but is slower and occasionally produces odd chat responses.

- **Docker sandbox** (recommended if you care about filesystem isolation). The agents otherwise run with the **same filesystem and network permissions as the backend process** — they can read `~/.ssh`, `~/.env`, other projects, etc. Turn on isolation by setting `DOCKER_SANDBOX=1` in `.env` and building the image once:

  ```bash
  docker build -t parallaxpro/agent-sandbox engine/backend/docker/agent-sandbox
  ```

  Every CLI invocation then runs inside an ephemeral container that only sees its per-fix sandbox dir and the agent's own auth dir.

### How It Works

1. You type a game prompt (e.g. "chess", "platformer", "fps shooter")
2. The AI selects the best matching template from 10+ game templates
3. The engine assembles the game: entities, scripts, UI, physics, FSM logic
4. You can play immediately, then ask the AI to fix bugs or add features
5. The editing agent reads your game code, edits scripts, and validates changes

### Creating New Game Templates

The best way to generate a completely new game from scratch is to open a CLI coding agent (like Claude Code) in the repo and ask it to create a new template:

```
engine/backend/src/ws/services/pipeline/reusable_game_components/
  game_templates/v0.1/   -- game templates (4-file format: flow, entities, worlds, systems)
  behaviors/v0.1/        -- per-entity behavior scripts (movement, combat, AI, etc.)
  systems/v0.1/          -- multi-entity system scripts (game managers, level logic)
  ui/v0.1/               -- HTML UI overlays (HUD, menus, panels)
```

Ask the agent to study the existing templates (like `chess/` or `fps_shooter/`), then create a new one with its own behaviors, systems, and UI. Once the template is created, open the editor and type the template name in the chat to see it assembled and running.

### 3D Assets

The hosted version at [parallaxpro.ai](https://parallaxpro.ai/) includes 5000+ 3D models, textures, and audio files from [Kenney](https://kenney.nl/), [Poly Haven](https://polyhaven.com/), and more.

When running locally, assets are automatically loaded from the ParallaxPro CDN. The asset browser and 3D models work out of the box with no additional downloads.

To use your own local assets, set `ASSETS_DIR` in your `.env` to a directory containing your 3D models (`.glb`), textures (`.png`, `.jpg`), and audio (`.ogg`, `.mp3`).

### Publishing Games

**We recommend publishing on [parallaxpro.ai](https://parallaxpro.ai/)** — it's the easiest way to get your game in front of players, with free hosting and a shareable `parallaxpro.ai/games/<you>/<game>` URL. Monetization tools are coming soon. Direct publishing from running locally (localhost) is in progress.

### License

Apache License 2.0. See [LICENSE](LICENSE).

<!-- <a href="https://www.star-history.com/?repos=ParallaxPro-AI%2FOpen-ParallaxPro&type=date&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=ParallaxPro-AI/Open-ParallaxPro&type=date&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=ParallaxPro-AI/Open-ParallaxPro&type=date&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=ParallaxPro-AI/Open-ParallaxPro&type=date&legend=top-left" />
 </picture>
</a> -->
