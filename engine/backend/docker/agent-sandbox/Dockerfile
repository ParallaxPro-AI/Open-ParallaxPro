# Sandbox image for the editing agents (claude-code, codex, opencode).
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

# Claude Code + Codex install cleanly via npm.
RUN npm install -g --no-fund --no-audit \
    @anthropic-ai/claude-code \
    @openai/codex

# OpenCode ships its own installer that writes to /root/.opencode/bin.
RUN curl -fsSL https://opencode.ai/install | bash \
    && ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode

# Container exec runs in the mounted sandbox dir; HOME is set via `-e` at
# runtime to match the host path so auth mounts resolve correctly.
WORKDIR /workspace
