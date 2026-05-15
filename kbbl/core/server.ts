import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, type KbblConfig } from "./config";
import { createSafirClient } from "./safir/client";
import { createSafirQueue } from "./safir/queue";
import { createSafirQueueWorker } from "./safir/queue-worker";
import { SessionManager } from "./session/session-manager";
import { Session } from "./session/session";
import { isGitRepo, isPathInside, resolveRepoTopLevel } from "./session/worktree";
import { createApp } from "./server/app";
import { createClaudeCodeRuntime } from "../adapters/claude-code";
import { validateWorkdir } from "./server/handlers/sessions";
import { openDb } from "./db/connection";
import { applyMigrations } from "./db/migrations";

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

if (!values.workdir) {
  console.error(
    "usage: bun run server.ts --workdir=<path> [--port=8788] [--host=<addr>] [--config=<path>]",
  );
  process.exit(1);
}

// Resolve to an absolute path before validation so /config and the initial
// session both see the same canonical workdir regardless of how the operator
// invoked kbbl-start (e.g. `--workdir=.` or a relative path from a script).
const workdir = resolve(values.workdir);
const startupWorkdirErr = await validateWorkdir(workdir);
if (startupWorkdirErr) {
  console.error(`kbbl: invalid --workdir=${values.workdir}: ${startupWorkdirErr}`);
  process.exit(1);
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
// Created unconditionally so the manager doesn't have to branch on the flag
// for path resolution. With the flag off the dir is empty and harmless.
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
//
// Only enforced when worktrees are actually enabled; flag-off operators
// don't need to care.
if (config.sessions.worktree_per_session && (await isGitRepo(workdir))) {
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

// === safir client + retry queue ===
// Constructed before the manager so SessionManagerOpts.safirClient/safirQueue
// are populated. The worker drains queued kbbl→safir writes on a fixed
// interval; transient failures (5xx, network) fall into the queue via
// safirCall, 4xx surfaces as a thrown error to the call site (real bug, not
// a retry candidate). API token is read from process.env at client
// construction; if unset, the Authorization header is omitted and safir
// (which doesn't validate auth as of 2026-05-09) accepts the request.

const safirClient = createSafirClient({
  baseUrl: config.safir.base_url,
  apiToken: process.env.SAFIR_API_TOKEN,
});
const safirQueue = createSafirQueue({ dataDir });
const safirWorker = createSafirQueueWorker({
  queue: safirQueue,
  client: safirClient,
  intervalSeconds: config.safir.queue_drain_interval_seconds,
});
safirWorker.start();

// === runtime adapter ===
// The Claude Code adapter owns its CLI flags, settings.json, and the
// PreToolUse gate route. Core consumes it through the AppRuntime contract
// and never imports CC-specific files directly.

const gatePath = resolve(moduleDir, "..", "adapters", "claude-code", "scripts", "gate.sh");
const runtime = await createClaudeCodeRuntime({
  claudeBin,
  port,
  dataDir,
  gatePath,
  safirClient,
  safirBaseUrl: config.safir.base_url.replace(/\/+$/, ""),
});

// === manager ===

const manager = new SessionManager({
  sessionsDir,
  handoffsDir,
  worktreesDir,
  buildSpawnCmd: runtime.buildSpawnCmd,
  classifyEvent: runtime.classifyEvent,
  nonPersistedEventTypes: runtime.nonPersistedEventTypes,
  config,
  safirClient,
  safirQueue,
});

// === Hono app ===

let bunServer: ReturnType<typeof Bun.serve> | null = null;
const app = createApp({
  manager,
  runtime,
  defaultWorkdir: workdir,
  sessionsDir,
  handoffsDir,
  pwaDistDir,
  safirClient,
  getBunServer: () => bunServer,
  config,
  configPath,
  db,
});

// === bind port (fail fast before spawning CC) ===

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
  `kbbl listening on http://${server.hostname}:${server.port}, workdir=${workdir}`,
);

// === auto-create initial session ===

let initialSession: Session;
try {
  initialSession = await manager.create({ workdir });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`kbbl: failed to spawn initial ${runtime.id} subprocess: ${msg}`);
  server.stop();
  process.exit(1);
}
console.error(`kbbl initial session ${initialSession.oakridgeSid}`);

// === signals ===

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      const worstCode = await manager.endAll();
      await manager.drainLifecycle();
      // Stop the safir queue worker after sessions have ended so any
      // teardown enqueues from afterSessionEnded (PR-B) drain into the
      // JSONL rather than the timer interval. Worker.stop() awaits the
      // current tick chain.
      await safirWorker.stop();
      server.stop();
      process.exit(worstCode);
    })();
  });
}
