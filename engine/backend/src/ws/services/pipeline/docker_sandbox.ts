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

type AgentId = 'claude' | 'codex' | 'opencode' | 'copilot';

const HOME = os.homedir();

/**
 * Per-CLI auth paths we bind-mount (RW so token refresh works).
 * Entries can be files OR dirs — Docker's `-v src:dst` handles both.
 * Claude in particular splits its config between `~/.claude.json` (the
 * main config file, required) and `~/.claude/` (credentials, history),
 * so both need to be mounted or the CLI exits with "configuration file
 * not found".
 */
const AUTH_DIRS: Record<AgentId, string[]> = {
    claude: [
        path.join(HOME, '.claude.json'),
        path.join(HOME, '.claude'),
        path.join(HOME, '.claude-code'),
        path.join(HOME, '.config', 'claude'),
    ],
    codex: [path.join(HOME, '.codex')],
    // opencode splits state across three dirs:
    //   ~/.opencode                    — install + plugins
    //   ~/.local/share/opencode        — auth.json + SQLite DB
    //   ~/.local/state/opencode        — selected/recent model (model.json)
    // All three must be visible inside the container so `opencode run`
    // authenticates, writes sessions, and picks the user's chosen model.
    opencode: [
        path.join(HOME, '.opencode'),
        path.join(HOME, '.local', 'share', 'opencode'),
        path.join(HOME, '.local', 'state', 'opencode'),
    ],
    // GitHub Copilot CLI keeps auth, session state, IDE integrations, and
    // logs in `~/.copilot` — one directory covers everything the CLI needs
    // to authenticate and resume/write sessions.
    copilot: [path.join(HOME, '.copilot')],
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
    const { uid, gid } = os.userInfo();
    const dockerArgs: string[] = [
        'run',
        '--rm',
        '-i',
        // tini as PID 1 inside the container: proper signal forwarding to
        // the agent process and zombie reaping. Without this, SIGTERM from
        // an aborted Stop/close can fail to reach the agent reliably, and
        // the container hangs until SIGKILL.
        '--init',
        // Default bridge network: outbound yes, but no access to host
        // services. Add `--network=none` later if we add a proxy.
        '--network', 'bridge',
        // Match the host user so (a) claude-code accepts
        // --dangerously-skip-permissions (refuses to run as root), and
        // (b) files the agent writes into the mounted sandbox dir are
        // owned by the host user, not root.
        '--user', `${uid}:${gid}`,
        // Sandbox dir mounted read-write as the agent's working dir.
        // We use the same path inside the container so any absolute paths
        // the agent writes back (e.g. in file_change events from codex)
        // match the host paths cli_fixer expects to read.
        '-v', `${sandboxDir}:${sandboxDir}`,
        '-w', sandboxDir,
    ];

    // The container has no /home/<user> baked in, so docker auto-creates it
    // (and any intermediate dirs like ~/.local, ~/.config) as root when we
    // bind-mount auth subpaths. That leaves them unwritable to uid 1001,
    // and agents explode trying to mkdir ~/.cache, ~/.local/state, etc.
    // Fix: tmpfs HOME + every intermediate dir leading to an auth mount,
    // owned by the host user. The bind mounts below then land on writable
    // tmpfs parents.
    const tmpfsDirs = new Set<string>([HOME]);
    for (const dir of AUTH_DIRS[agent]) {
        if (!fs.existsSync(dir)) continue;
        let p = path.dirname(dir);
        while (p.startsWith(HOME) && p !== HOME && p !== '/') {
            tmpfsDirs.add(p);
            p = path.dirname(p);
        }
    }
    tmpfsDirs.forEach(d => {
        dockerArgs.push('--tmpfs', `${d}:uid=${uid},gid=${gid},mode=755`);
    });

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
