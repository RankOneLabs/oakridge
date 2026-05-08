import { parseArgs } from "node:util";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config";
import { SessionManager } from "./session/session-manager";
import { Session } from "./session/session";
import { createApp } from "./server/app";
import { createClaudeCodeRuntime } from "../adapters/claude-code";
import { validateWorkdir } from "./server/handlers/sessions";

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
  console.error("usage: bun run server.ts --workdir=<path> [--port=8788]");
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

// === config ===
// Load before binding the port so a malformed config.json fails fast, with
// the file path in the message, rather than crashing later inside a session
// when the first compact threshold is consulted.

const configPath = values.config ?? join(kbblRoot, "config.json");
let config;
try {
  config = loadConfig(configPath);
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

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
});

// === manager ===

const manager = new SessionManager({
  sessionsDir,
  buildSpawnCmd: runtime.buildSpawnCmd,
  classifyEvent: runtime.classifyEvent,
  nonPersistedEventTypes: runtime.nonPersistedEventTypes,
  config,
});

// === Hono app ===

let bunServer: ReturnType<typeof Bun.serve> | null = null;
const app = createApp({
  manager,
  runtime,
  defaultWorkdir: workdir,
  sessionsDir,
  pwaDistDir,
  getBunServer: () => bunServer,
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
      server.stop();
      process.exit(worstCode);
    })();
  });
}
