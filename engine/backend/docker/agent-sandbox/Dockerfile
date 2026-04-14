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

# OpenCode ships its own installer that writes to /root/.opencode/bin. Move
# it to /opt so uid 1001 (the host user we spawn as) can traverse + execute
# it — /root is 0700 and unreadable to non-root users inside the container.
RUN curl -fsSL https://opencode.ai/install | bash \
    && mv /root/.opencode /opt/opencode \
    && chmod -R a+rX /opt/opencode \
    && ln -sf /opt/opencode/bin/opencode /usr/local/bin/opencode

# Reset node base image's entrypoint — docker-entrypoint.sh wraps anything
# `command -v` can't resolve in `node`, which silently turns our agent
# invocation into `node opencode ...` → MODULE_NOT_FOUND.
ENTRYPOINT []

# Container exec runs in the mounted sandbox dir; HOME is set via `-e` at
# runtime to match the host path so auth mounts resolve correctly.
WORKDIR /workspace
