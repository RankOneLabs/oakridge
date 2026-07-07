import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type KbblConfig } from "./config";
import { SessionManager } from "./session/session-manager";
import type { Session } from "./session/session";
import { isGitRepo, isPathInside, resolveRepoTopLevel } from "./session/worktree";
import { createApp } from "./server/app";
import { createClaudeCodeRuntime } from "../adapters/claude-code";
import { createCodexRuntime } from "../adapters/codex";
import { createRuntimeRegistry } from "./runtime";
import { validateWorkdir } from "./server/handlers/sessions";
import { openDb } from "./db/connection";
import { applyMigrations } from "./db/migrations";
import { bootstrap as bootstrapOrchestrator } from "./orchestrator/bootstrap";
import { createKbblChatBackend } from "./orchestrator/backends/kbbl-chat";
import { createDispatcher } from "./orchestrator/backends/dispatcher";
import { wireDispatchHooks } from "./orchestrator/dispatch-hooks";
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
const claudeBin = values.claudeBin ?? "claude";

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

// === runtime adapter ===
// The Claude Code adapter owns its CLI flags, settings.json, and the
// hook routes. Core consumes it through the AppRuntime contract
// and never imports CC-specific files directly.

const runtime = await createClaudeCodeRuntime({
  claudeBin,
  port,
  dataDir,
});

// === runtime registry ===

const runtimes: import("./runtime").AgentRuntime[] = [runtime];
if (config.runtime.codex.enabled) {
  const codexBin = config.runtime.codex.bin || "codex";
  const codexListen =
    config.runtime.codex.listen ??
    `unix://${join(dataDir, "codex-app-server.sock")}`;
  try {
    const codexRuntime = await createCodexRuntime({
      bin: codexBin,
      listenUrl: codexListen,
      sessionsDir,
    });
    runtimes.push(codexRuntime);
    console.error(
      `kbbl: Codex runtime started (listen=${codexListen})`,
    );
  } catch (err) {
    console.error(
      `kbbl: failed to start Codex runtime: ${
        err instanceof Error ? err.message : String(err)
      } (continuing without Codex)`,
    );
  }
}

const registeredRuntimeIds = new Set(runtimes.map((r) => r.id));
const configuredDefaultRuntime = registeredRuntimeIds.has(config.runtime.default)
  ? config.runtime.default
  : undefined;
const registry = createRuntimeRegistry(runtimes, configuredDefaultRuntime);
if (!configuredDefaultRuntime) {
  console.error(
    `kbbl: configured default runtime "${config.runtime.default}" is unavailable; using "${registry.defaultId}" instead`,
  );
}

// The CC adapter owns the ccSid→oakridgeSid map. Expose callback hooks so
// the manager can delegate getByCcSid lookups without importing CC directly.
type CcRuntimeExtensions = {
  registerCcSid: (ccSid: string, oakridgeSid: string) => void;
  unregisterBySid: (session: Session) => void;
  lookupByCcSid: (ccSid: string) => Session | undefined;
  trackSession: (s: Session) => void;
};
const ccRuntime = runtime as typeof runtime & CcRuntimeExtensions;

// === manager ===

const manager = new SessionManager({
  sessionsDir,
  handoffsDir,
  worktreesDir,
  // Legacy buildSpawnCmd kept as fallback (not used when registry is set, but
  // satisfies backward-compat tests and any path that bypasses the registry).
  buildSpawnCmd: runtime.buildSpawnCmd,
  classifyEvent: runtime.classifyEvent,
  nonPersistedEventTypes: runtime.nonPersistedEventTypes,
  registry,
  lookupByCcSid: (ccSid) => ccRuntime.lookupByCcSid(ccSid),
  onRuntimeSessionObserved: (session, runtimeSid) => {
    ccRuntime.registerCcSid(runtimeSid, session.oakridgeSid);
    ccRuntime.trackSession(session);
  },
  onRuntimeSessionEnded: (session) => {
    ccRuntime.unregisterBySid(session);
  },
  config,
});

// === Dispatcher + dispatch hooks + responder spawn ===

const kbblChatBackend = createKbblChatBackend({ manager });
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
const app = createApp({
  manager,
  runtime,
  registry,
  defaultWorkdir: workdir,
  sessionsDir,
  handoffsDir,
  pwaDistDir,
  getBunServer: () => bunServer,
  config,
  configPath,
  db,
  dispatcher,
});

// === bind port ===

try {
  bunServer = Bun.serve({
    port,
    hostname: host,
    idleTimeout: 255,
    fetch: app.fetch,
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
      const worstCode = await manager.endAll();
      await manager.drainLifecycle();
      // Stop any optional app-servers (e.g. Codex). Capability-based: only
      // runtimes that expose stopAppServer need to be stopped. Failure is
      // logged but does not block process exit — a stuck teardown would be a
      // worse outcome than leaking a socket.
      for (const r of runtimes) {
        const stopAppServer = (r as unknown as { stopAppServer?: () => Promise<void> }).stopAppServer;
        if (stopAppServer) {
          await stopAppServer().catch((err: unknown) => {
            console.error(
              `kbbl: ${r.id} stopAppServer error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        }
      }
      server.stop();
      process.exit(worstCode);
    })();
  });
}
