import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SessionManager } from "./session/session-manager";
import { Session } from "./session/session";
import { inboxHandler } from "./stream/inbox";
import { makeBuildSpawnCmd, writeCcSettings } from "./server/spawn-cmd";
import { hookApprovalHandler } from "./server/handlers/hook";
import { mountPerSidRoutes } from "./server/handlers/per-sid";
import {
  mountSessionsRoutes,
  validateWorkdir,
} from "./server/handlers/sessions";

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
  },
});

if (!values.workdir) {
  console.error("usage: bun run server.ts --workdir=<path> [--port=8788]");
  process.exit(1);
}

// Resolve to an absolute path before validation so /config and the initial
// session both see the same canonical workdir regardless of how the operator
// invoked cc-start (e.g. `--workdir=.` or a relative path from a script).
const workdir = resolve(values.workdir);
const startupWorkdirErr = await validateWorkdir(workdir);
if (startupWorkdirErr) {
  console.error(`cc-deck: invalid --workdir=${values.workdir}: ${startupWorkdirErr}`);
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
const dataDir = values.dataDir ?? join(moduleDir, "..", "data");
const pwaDistDir = join(moduleDir, "pwa", "dist");
const sessionsDir = join(dataDir, "sessions");
await mkdir(sessionsDir, { recursive: true });

// === settings.json for spawned CC (shared across all sessions) ===
// CC-specific spawn config lives in ./server/spawn-cmd.ts. Will move to
// kbbl/adapters/claude-code/ in PR 3.

const gatePath = resolve(moduleDir, "..", "adapters", "claude-code", "scripts", "gate.sh");
const settingsPath = await writeCcSettings({ dataDir, gatePath });
const buildSpawnCmd = makeBuildSpawnCmd({ claudeBin, port, settingsPath });

// === manager ===

const manager = new SessionManager({ sessionsDir, buildSpawnCmd });

// === HTTP handlers ===

// === Hono app ===

const app = new Hono();

// ---- hook (loopback-only) ----
//
// Registered BEFORE /:sid/* so Hono's registration-order match doesn't
// catch POST /hook/approval as /:sid/approval with sid="hook".
// Handler in ./server/handlers/hook.ts (CC-coupled; will move into the
// claude-code adapter in PR 3).

app.post(
  "/hook/approval",
  hookApprovalHandler({ manager, getBunServer: () => bunServer }),
);

// ---- per-sid routes ----
// All five (/stream, /events, /input, /yolo, /approval) live in
// ./server/handlers/per-sid.ts.
mountPerSidRoutes(app, { manager, sessionsDir });

// ---- server config ----
//
// Exposes the operator-configured defaults the PWA needs to render forms
// (currently just the default workdir). Kept tiny on purpose: this is not a
// place to grow generic settings — anything per-session belongs in the
// session snapshot.

app.get("/config", (c) => {
  return c.json({ defaultWorkdir: workdir });
});

// ---- sessions CRUD ----
// All three routes (GET /sessions, POST /sessions, DELETE /sessions/:sid)
// plus validateWorkdir and resolveResumeParent live in
// ./server/handlers/sessions.ts.
mountSessionsRoutes(app, {
  manager,
  defaultWorkdir: workdir,
  sessionsDir,
});

// ---- /inbox (always-on delta stream) ---- handler in ./stream/inbox.ts
app.get("/inbox", inboxHandler(manager));

// ---- static PWA ----

app.use(
  "/*",
  serveStatic({
    root: pwaDistDir,
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);

// === bind port (fail fast before spawning CC) ===

let bunServer: ReturnType<typeof Bun.serve> | null = null;
try {
  bunServer = Bun.serve({
    port,
    hostname: host,
    idleTimeout: 255,
    fetch: app.fetch,
  });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cc-deck: failed to bind port ${port}: ${msg}`);
  console.error(`is another cc-deck running? try: lsof -i :${port}`);
  process.exit(1);
}
const server = bunServer;

console.error(
  `cc-deck listening on http://${server.hostname}:${server.port}, workdir=${workdir}`,
);

// === auto-create initial session ===

let initialSession: Session;
try {
  initialSession = await manager.create({ workdir });
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`cc-deck: failed to spawn initial CC subprocess: ${msg}`);
  server.stop();
  process.exit(1);
}
console.error(`cc-deck initial session ${initialSession.oakridgeSid}`);

// === signals ===

let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void (async () => {
      const worstCode = await manager.endAll();
      server.stop();
      process.exit(worstCode);
    })();
  });
}
