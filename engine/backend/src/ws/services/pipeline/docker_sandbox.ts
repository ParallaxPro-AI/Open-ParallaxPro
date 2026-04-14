/**
 * docker_sandbox.ts — optional Docker-based isolation for the editing agents.
 *
 * When `DOCKER_SANDBOX=1` is set in the backend env, every CLI agent spawn
 * (claude / codex / opencode) runs inside a short-lived container instead
 * of directly on the host. The container:
 *
 *   - Has its own filesystem (can't read the host's `~/.ssh`, `~/.env`,
 *     other projects, etc. — only the mounts we grant).
 *   - Has its own pid + user namespaces (can't see host processes).
 *   - Has outbound network via Docker's default bridge (so the CLI can
 *     still reach its model provider).
 *
 * What's mounted:
 *   - The per-fix sandbox dir (RW) at `/workspace` — this is where the
 *     agent reads TASK.md, edits project files, runs validate.sh.
 *   - The agent's auth dir (RW) at the same path inside the container
 *     so the CLI finds its credentials and can refresh tokens.
 *
 * What's NOT mounted:
 *   - Anything else from `$HOME`. SSH keys, dotfiles, other projects,
 *     `~/.env` — all invisible to the agent.
 *
 * The image is expected at `$DOCKER_SANDBOX_IMAGE`
 * (default `parallaxpro/agent-sandbox:latest`) and ships with the three
 * CLIs preinstalled. Build it once on the host:
 *   `docker build -t parallaxpro/agent-sandbox engine/backend/docker/agent-sandbox`
 *
 * When `DOCKER_SANDBOX` is unset or falsy, spawns run on the host as
 * before — no Docker dependency required for local dev.
 */

import { spawnSync } from 'child_process';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

type AgentId = 'claude' | 'codex' | 'opencode';

const HOME = os.homedir();

/** Per-CLI auth dirs we bind-mount (RW so token refresh works). */
const AUTH_DIRS: Record<AgentId, string[]> = {
    claude: [
        path.join(HOME, '.claude'),
        path.join(HOME, '.claude-code'),
        path.join(HOME, '.config', 'claude'),
    ],
    codex: [path.join(HOME, '.codex')],
    opencode: [path.join(HOME, '.opencode')],
};

let cachedEnabled: boolean | null = null;
let cachedProbe: { ok: boolean; reason: string } | null = null;

/** Is Docker sandboxing turned on via env? Cached for process lifetime. */
export function isDockerSandboxEnabled(): boolean {
    if (cachedEnabled !== null) return cachedEnabled;
    const v = process.env.DOCKER_SANDBOX;
    cachedEnabled = v === '1' || v === 'true' || v === 'yes';
    return cachedEnabled;
}

/** Image tag to use for the sandbox container. */
export function dockerSandboxImage(): string {
    return process.env.DOCKER_SANDBOX_IMAGE || 'parallaxpro/agent-sandbox:latest';
}

/**
 * Probe once at startup: does `docker` exist on PATH, and is the image
 * present? If either check fails, log a clear message but keep the
 * backend running — the fixer will still work, just without
 * sandboxing. (We don't auto-disable DOCKER_SANDBOX; if someone set it
 * they probably want to know the check failed.)
 */
export function probeDockerSandbox(): { ok: boolean; reason: string } {
    if (cachedProbe) return cachedProbe;
    if (!isDockerSandboxEnabled()) {
        cachedProbe = { ok: false, reason: 'DOCKER_SANDBOX is not enabled' };
        return cachedProbe;
    }
    const docker = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (docker.status !== 0) {
        cachedProbe = { ok: false, reason: 'docker command not found or daemon not reachable' };
        return cachedProbe;
    }
    const img = spawnSync('docker', ['image', 'inspect', dockerSandboxImage()], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] });
    if (img.status !== 0) {
        cachedProbe = { ok: false, reason: `image "${dockerSandboxImage()}" not found — build with: docker build -t ${dockerSandboxImage()} engine/backend/docker/agent-sandbox` };
        return cachedProbe;
    }
    cachedProbe = { ok: true, reason: `docker ok, using image ${dockerSandboxImage()}` };
    return cachedProbe;
}

/**
 * Return the command + args to actually spawn. When the sandbox is enabled
 * the CLI invocation is wrapped in `docker run`; otherwise arguments are
 * returned unchanged.
 */
export function wrapSpawn(
    agent: AgentId,
    cmd: string,
    args: string[],
    sandboxDir: string,
): { command: string; args: string[] } {
    if (!isDockerSandboxEnabled()) return { command: cmd, args };
    // Fall through to a direct spawn if the probe fails, so misconfigured
    // hosts still work — startup logs a warning either way.
    if (!probeDockerSandbox().ok) return { command: cmd, args };

    const image = dockerSandboxImage();
    const dockerArgs: string[] = [
        'run',
        '--rm',
        '-i',
        // Default bridge network: outbound yes, but no access to host
        // services. Add `--network=none` later if we add a proxy.
        '--network', 'bridge',
        // Sandbox dir mounted read-write as the agent's working dir.
        // We use the same path inside the container so any absolute paths
        // the agent writes back (e.g. in file_change events from codex)
        // match the host paths cli_fixer expects to read.
        '-v', `${sandboxDir}:${sandboxDir}`,
        '-w', sandboxDir,
    ];

    // Auth dirs: same path inside and out so the CLI's default lookup
    // (`$HOME/.claude`, etc.) still works. We also pass HOME through so
    // the CLI finds `$HOME/.claude` at the expected location.
    for (const dir of AUTH_DIRS[agent]) {
        if (fs.existsSync(dir)) {
            dockerArgs.push('-v', `${dir}:${dir}`);
        }
    }
    dockerArgs.push('-e', `HOME=${HOME}`);

    dockerArgs.push(image, cmd, ...args);
    return { command: 'docker', args: dockerArgs };
}
