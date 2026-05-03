# Sandbox image for the editing agents (claude-code, codex, opencode, copilot).
# Used only when DOCKER_SANDBOX=1 is set on the host backend.
#
# Build:
#   docker build -t parallaxpro/agent-sandbox engine/backend/docker/agent-sandbox
#
# Auth stays on the host and is bind-mounted at runtime (see docker_sandbox.ts).

FROM node:20-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        curl \
        ca-certificates \
        unzip \
        git \
    && rm -rf /var/lib/apt/lists/*

# Claude Code + Codex + GitHub Copilot CLI install cleanly via npm.
# (`@github/copilot` is the agentic Copilot CLI binary — same package the
# brew cask `copilot-cli` ships, just installed via npm in the container.)
RUN npm install -g --no-fund --no-audit \
    @anthropic-ai/claude-code \
    @openai/codex \
    @github/copilot

# OpenCode ships its own installer that writes to /root/.opencode/bin. Move
# it to /opt so uid 1001 (the host user we spawn as) can traverse + execute
# it — /root is 0700 and unreadable to non-root users inside the container.
RUN curl -fsSL https://opencode.ai/install | bash \
    && mv /root/.opencode /opt/opencode \
    && chmod -R a+rX /opt/opencode \
    && ln -sf /opt/opencode/bin/opencode /usr/local/bin/opencode

# Headless playtest support. The agent's validate.sh runs `playtest project/`
# inline so failures surface during the agent's own turn budget instead of
# only on an orchestrator-side respawn. tsx is the runtime — it transpiles
# the bind-mounted engine TS sources at startup; we install it globally so
# its bundled Linux esbuild build is used (the host's engine/headless
# node_modules may be macOS / cross-platform).
RUN npm install -g --no-fund --no-audit tsx

# Wrapper that runs the headless playtest against the bind-mounted engine
# source. docker_sandbox.ts mounts the host's engine/ directory RO at
# /opt/parallaxpro/engine. The Rapier WASM binding (@dimforge/rapier3d-compat)
# is platform-agnostic, so the bind-mounted host node_modules works directly.
RUN printf '%s\n' \
    '#!/bin/bash' \
    '# Wrapper auto-installed by the agent-sandbox image.' \
    '# Runs the headless playtest cli against a project directory.' \
    'exec tsx /opt/parallaxpro/engine/headless/src/cli.ts "$@"' \
    > /usr/local/bin/playtest \
    && chmod +x /usr/local/bin/playtest

# Reset node base image's entrypoint — docker-entrypoint.sh wraps anything
# `command -v` can't resolve in `node`, which silently turns our agent
# invocation into `node opencode ...` → MODULE_NOT_FOUND.
ENTRYPOINT []

# Container exec runs in the mounted sandbox dir; HOME is set via `-e` at
# runtime to match the host path so auth mounts resolve correctly.
WORKDIR /workspace
