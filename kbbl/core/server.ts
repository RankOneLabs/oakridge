import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type KbblConfig } from "./config";
import { resolveStartupAuthPolicy, type AuthPolicy } from "./server/auth";
import { SessionManager } from "./session/session-manager";
import { isGitRepo, isPathInside, resolveRepoTopLevel } from "./session/worktree";
import { createApp } from "./server/app";
import { loadAgentProfiles } from "./acp/agent-profile";
import { builtinAgentProfiles } from "./acp/default-profiles";
import { AcpControllerRegistry } from "./acp/controller-registry";
import { AcpProcessSupervisor } from "./acp/process-supervisor";
import { AcpSessionService } from "./acp/session-service";
import { AcpSessionStore } from "./acp/store";
import { GitWorktreeProvider } from "./worktree/service";
import { validateWorkdir } from "./server/handlers/sessions";
import { openDb } from "./db/connection";
import { applyMigrations } from "./db/migrations";
import { bootstrap as bootstrapOrchestrator } from "./orchestrator/bootstrap";
import { createKbblChatBackend } from "./orchestrator/backends/kbbl-chat";
import { createDispatcher } from "./orchestrator/backends/dispatcher";
import { wireDispatchHooks } from "./orchestrator/dispatch-hooks";
import {
  reconcileDispatchAttempts,
  settleAttemptForEndedSession,
} from "./orchestrator/dispatch-reconciler";
import { wireResponderSpawn } from "./orchestrator/responders/spawn";
import { reviewRegistry } from "./review/registry";
import { reviewEvents } from "./review/events";
import { taskTrackerEvents } from "./db/events";

// === args ===

const { values } = parseArgs({
  options: {
    workdir: { type: "string" },
    port: { type: "string", default: "8788" },
    // Default to loopback so a laptop connected to mixed networks (home wifi,
    // coffee shop, etc.) doesn't silently expose unauthenticated /input,
    // /approval, /stream, /events to any reachable peer. Operator opts into
    // phone/tablet access over Tailscale with --host=0.0.0.0.
    host: { type: "string", default: "127.0.0.1" },
    claudeBin: { type: "string", default: "claude" },
    dataDir: { type: "string" },
    // Path to kbbl/config.json. Default is `<kbbl-root>/config.json`. A
    // missing file resolves to schema defaults; tests and dev workflows
    // can pass an alternate path here without touching the canonical file.
    config: { type: "string" },
  },
});

// If provided, resolve to an absolute path before validation so /config and
// new-session defaults see the same canonical workdir regardless of how the
// operator invoked kbbl-start (e.g. `--workdir=.` or a relative path from a script).
const workdir = values.workdir ? resolve(values.workdir) : null;
if (workdir !== null) {
  const startupWorkdirErr = await validateWorkdir(workdir);
  if (startupWorkdirErr) {
    console.error(`kbbl: invalid --workdir=${values.workdir}: ${startupWorkdirErr}`);
    process.exit(1);
  }
}
const port = Number(values.port);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`invalid --port=${values.port}`);
  process.exit(1);
}
const host = values.host ?? "127.0.0.1";
// --claudeBin is still accepted so operator launch scripts don't break, but
// agent binaries now come from ACP profiles (config.acp.agents).

// === auth policy ===
// Resolved before any other startup work so a misconfigured non-loopback
// bind fails fast with a clear message rather than opening an unprotected
// port and only surfacing the problem at the first control request.
let authPolicy: AuthPolicy;
try {
  authPolicy = resolveStartupAuthPolicy({
    host,
    controlToken: process.env.OAKRIDGE_CONTROL_TOKEN,
    allowInsecure: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1",
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error(
    "kbbl: Set OAKRIDGE_CONTROL_TOKEN or ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 to bind on non-loopback interfaces.",
  );
  process.exit(1);
}
if (authPolicy.mode === "insecure-non-loopback") {
  console.error(
    "kbbl: WARNING: running without authentication on a non-loopback bind (ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1). " +
    "Set OAKRIDGE_CONTROL_TOKEN to protect control routes.",
  );
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
// server.ts lives at kbbl/core/server.ts. From its directory, `..` is the kbbl package root;
// data/ and adapters/ are both children of that root (siblings of core/).
const kbblRoot = join(moduleDir, "..");
const dataDir = values.dataDir ?? join(kbblRoot, "data");
const pwaDistDir = join(moduleDir, "pwa", "dist");
const sessionsDir = join(dataDir, "sessions");
await mkdir(sessionsDir, { recursive: true });
const handoffsDir = join(dataDir, "handoffs");
await mkdir(handoffsDir, { recursive: true });

// === sqlite db ===
const dbPath = join(dataDir, "kbbl.db");
const db = openDb(dbPath);
applyMigrations(db, join(moduleDir, "db", "migrations"));
bootstrapOrchestrator({ db, registry: reviewRegistry, reviewEvents, taskTrackerEvents });

// === config ===
// Load before binding the port so a malformed config.json fails fast, with
// the file path in the message, rather than crashing later inside a session
// when the first compact threshold is consulted.

const configPath = values.config ?? join(kbblRoot, "config.json");
let config: KbblConfig;
try {
  config = loadConfig(configPath);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

// === worktrees ===
const worktreesDir = join(dataDir, config.sessions.worktree_dir_name);
await mkdir(worktreesDir, { recursive: true });

// Nesting check: when the operator's --workdir is inside a git repo AND
// worktreesDir lives inside that repo's tree, every per-session worktree
// would land inside the outer repo's working tree. That's only safe if the
// outer repo gitignores the path; otherwise `git status` from the outer
// repo surfaces every session's checkout as untracked — exactly the
// cross-session pollution per-worktree isolation is meant to prevent.
//
// We compare against `git rev-parse --show-toplevel`, not against `workdir`
// directly: an operator launching kbbl from a subdirectory of a repo would
// otherwise sneak past the check whenever worktreesDir landed in a sibling
// of that subdir but still inside the repo root.
if (workdir !== null && (await isGitRepo(workdir))) {
  const repoRoot = await resolveRepoTopLevel(workdir);
  if (isPathInside(worktreesDir, repoRoot)) {
    const ignoreCheck = Bun.spawn({
      cmd: ["git", "-C", repoRoot, "check-ignore", "-q", worktreesDir],
      stdout: "pipe",
      stderr: "pipe",
    });
    const ignoreCode = await ignoreCheck.exited;
    // git check-ignore: 0 = ignored (safe), 1 = not ignored (unsafe), 128 = error.
    if (ignoreCode !== 0) {
      console.error(
        `kbbl: worktreesDir ${worktreesDir} is inside the repo at ${repoRoot}`,
      );
      console.error(
        `kbbl: but is not gitignored by it. Per-session worktrees would pollute`,
      );
      console.error(
        `kbbl: the outer repo's git status. Either:`,
      );
      console.error(
        `kbbl:   - add ${worktreesDir} to ${repoRoot}/.gitignore, or`,
      );
      console.error(
        `kbbl:   - pass --dataDir=<path-outside-${repoRoot}>`,
      );
      process.exit(1);
    }
  }
}

// === ACP session stack (§21) ===
// The ACP substrate replaces the provider runtime adapters: agent profiles
// describe how to launch each ACP agent binary; the service owns session
// lifecycle over the shared SQLite store.

if (config.runtime.codex.enabled || config.runtime.default !== "claude-code") {
  console.error(
    "kbbl: config `runtime.*` is deprecated — provider sessions now run through ACP. " +
      "Configure agents under `acp.agents` / `acp.default_agent`; the old block is ignored except runtime.default as a default-agent alias.",
  );
}
const acpProfiles = loadAgentProfiles(config.acp, builtinAgentProfiles(kbblRoot));
const acpStore = new AcpSessionStore(db);
const acpSupervisor = new AcpProcessSupervisor({
  graceful_kill_ms: config.acp.graceful_kill_ms,
  hard_kill_ms: config.acp.hard_kill_ms,
});
const acpControllers = new AcpControllerRegistry();
const acpWorktrees = new GitWorktreeProvider({
  worktreesRoot: worktreesDir,
  store: acpStore,
});
// One-release alias (§20.2): an explicit acp.default_agent always wins —
// including an explicit "claude-code". Only when the key is absent does
// the legacy runtime.default apply (it defaults to claude-code itself).
const defaultAgent = config.acp.default_agent ?? config.runtime.default;
const acpService = new AcpSessionService({
  store: acpStore,
  controllers: acpControllers,
  profiles: acpProfiles,
  supervisor: acpSupervisor,
  worktrees: acpWorktrees,
  config: {
    default_agent: defaultAgent,
    graceful_kill_ms: config.acp.graceful_kill_ms,
    idle_child_ttl_ms: config.acp.idle_child_ttl_ms,
    live_event_buffer: config.acp.live_event_buffer,
  },
  onSessionEnded: (sid) => {
    settleAttemptForEndedSession(db, acpService, sid);
  },
});
acpService.recoverOnBoot();
const idleReaper = setInterval(() => {
  void acpService.reapIdleChildren();
}, 60_000);
idleReaper.unref?.();

// === legacy manager (read-only) ===
// Pre-cutover sessions live as JSONL transcripts. The manager only
// lists/serves those archives and lets an operator purge one; it spawns
// nothing.

const manager = new SessionManager({ sessionsDir });

// === Boot reconciliation — must run before dispatch hooks accept new work ===
// Any dispatch_attempts left in dispatching or running status survived a prior
// process death. Settle each from the durable ACP record (recoverOnBoot has
// already swept in-flight turns) or fail it so the active-claim slot is freed
// with a clear recovery path before new dispatches fire.
reconcileDispatchAttempts(db, manager, acpService);

// === Dispatcher + dispatch hooks + responder spawn ===

const kbblChatBackend = createKbblChatBackend({ acp: acpService });
// Internal URL for in-process dispatchers and spawned responders. Always
// loopback regardless of the operator's bind host: --host=0.0.0.0 (or a raw
// IPv6 address) is fine as an external listener but would resolve to a
// non-routable or malformed origin for self-calls. Subprocesses run on the
// same machine as the server, so 127.0.0.1 is the right target.
const kbblUrl = `http://127.0.0.1:${port}`;
const dispatcher = createDispatcher({ db, backends: { kbbl_chat: kbblChatBackend }, kbblUrl });
wireDispatchHooks({ taskTrackerEvents, dispatcher, db });
wireResponderSpawn({ reviewEvents, kbblUrl });

// === Hono app ===

let bunServer: ReturnType<typeof Bun.serve> | null = null;
const coreControlToken =
  process.env.OAKRIDGE_CORE_CONTROL_TOKEN?.trim() ||
  process.env.OAKRIDGE_CONTROL_TOKEN?.trim() ||
  undefined;

const app = createApp({
  manager,
  acp: acpService,
  defaultWorkdir: workdir,
  handoffsDir,
  pwaDistDir,
  getBunServer: () => bunServer,
  config,
  configPath,
  db,
  dispatcher,
  authPolicy,
  coreControlToken,
});

// === bind port ===

try {
  bunServer = Bun.serve({
    port,
    hostname: host,
    idleTimeout: 255,
    fetch(request, server) {
      // Bun's request deadline also applies while a streaming handler is
      // producing its initial response. Oakridge's invalidation feed is an
      // intentionally unbounded SSE request, so opt it out explicitly. Without
      // this, the browser reconnect loop can eventually trigger Bun 1.3.x's
      // timeout/crash path even though the stream sends heartbeats.
      if (new URL(request.url).pathname === "/oakridge/api/events") {
        server.timeout(request, 0);
      }
      return app.fetch(request);
    },
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`kbbl: failed to bind port ${port}: ${msg}`);
  console.error(`is another kbbl running? try: lsof -i :${port}`);
  process.exit(1);
}
const server = bunServer;

console.error(
  `kbbl listening on http://${server.hostname}:${server.port}, defaultWorkdir=${workdir ?? "(none)"}`,
);

// === signals ===

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      // Bounded ACP shutdown (§21): each controller closes within the
      // configured grace, then children are hard-killed by the supervisor.
      // Never wait indefinitely for an ACP child.
      clearInterval(idleReaper);
      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        acpService.shutdown(),
        new Promise<void>((resolveWait) => {
          timeoutId = setTimeout(resolveWait, config.acp.graceful_kill_ms + config.acp.hard_kill_ms + 2_000);
        }),
      ]).finally(() => {
        if (timeoutId !== undefined) clearTimeout(timeoutId);
      });
      server.stop();
      process.exit(0);
    })();
  });
}
