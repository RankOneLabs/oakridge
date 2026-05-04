import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { parseArgs } from "node:util";
import { mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RemoveFailedError,
  SessionManager,
  type CreateSessionOpts,
} from "./session/session-manager";
import {
  Session,
  readJsonlOrEmpty,
  type EnvelopeEvent,
} from "./session/session";
import { inboxHandler } from "./stream/inbox";
import { makeBuildSpawnCmd, writeCcSettings } from "./server/spawn-cmd";
import { hookApprovalHandler } from "./server/handlers/hook";
import { isValidSid, mountPerSidRoutes } from "./server/handlers/per-sid";

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

app.get("/sessions", async (c) => {
  const inMemory = manager.listSnapshots();
  const include = c.req.query("include");
  if (include !== "archived") return c.json({ sessions: inMemory });
  // Scan data/sessions/*.jsonl for sessions from prior runs. Ordered newest
  // first by lastActivityTs so the PWA can render without a second sort.
  const archived = await manager.listArchivedSnapshots();
  const merged = [...inMemory, ...archived].sort((a, b) => {
    if (a.lastActivityTs === b.lastActivityTs) return 0;
    return a.lastActivityTs < b.lastActivityTs ? 1 : -1;
  });
  return c.json({ sessions: merged });
});

// ---- /inbox (always-on delta stream) ---- handler in ./stream/inbox.ts
app.get("/inbox", inboxHandler(manager));

app.post("/sessions", async (c) => {
  // Optional body: { resume_from?: string, workdir?: string, name?: string
  // (≤80 chars) }. No body / missing fields = a fresh session under the
  // server's --workdir with a server-generated name. resume_from is an
  // oakridgeSid whose parent CC session should be inherited as context via
  // --resume <parentCcSid> --fork-session, and ignores any workdir override
  // (the parent's workdir is authoritative).
  let resumeFrom: string | null = null;
  let bodyWorkdir: string | null = null;
  let bodyName: string | null = null;
  // Read raw text first so we can distinguish "no body" (treat as no
  // options, preserves the old POST /sessions behavior) from "bad body"
  // (400). Using c.req.json() with an inner .catch() would silently
  // turn malformed JSON into "no options" — a bad body would create
  // a fresh session instead of erroring.
  try {
    const bodyText = await c.req.text();
    if (bodyText !== "") {
      const raw = JSON.parse(bodyText) as unknown;
      // Reject arrays / strings / numbers explicitly: property access on
      // them silently yields undefined, so without this check a body like
      // `[]` or `"foo"` would slip through as "no options" and spawn a
      // fresh session under --workdir, masking client bugs.
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return c.json({ error: "json body must be an object" }, 400);
      }
      const parsed = raw as {
        resume_from?: unknown;
        workdir?: unknown;
        name?: unknown;
      };
      if (parsed.resume_from !== undefined) {
        if (typeof parsed.resume_from !== "string") {
          return c.json({ error: "resume_from must be a string" }, 400);
        }
        resumeFrom = parsed.resume_from;
      }
      if (parsed.workdir !== undefined) {
        if (typeof parsed.workdir !== "string") {
          return c.json({ error: "workdir must be a string" }, 400);
        }
        bodyWorkdir = parsed.workdir;
      }
      if (parsed.name !== undefined) {
        if (typeof parsed.name !== "string") {
          return c.json({ error: "name must be a string" }, 400);
        }
        // Validate after trimming so leading/trailing whitespace can't
        // push an otherwise-valid name past the cap. All-whitespace
        // trims to empty, which manager.create()'s slug fallback
        // handles the same as an omitted name, so we just store the
        // trimmed value (possibly empty) and let create() decide.
        const trimmedName = parsed.name.trim();
        if (trimmedName.length > 80) {
          return c.json({ error: "name must be ≤ 80 chars after trimming" }, 400);
        }
        bodyName = trimmedName;
      }
    }
  } catch {
    return c.json({ error: "invalid json" }, 400);
  }

  let spawnOpts: CreateSessionOpts;
  if (resumeFrom === null) {
    // Normalize via resolve() so /repo, /repo/, and /repo/..//repo all
    // collapse to one canonical workdir before validation + persistence —
    // matches the startup --workdir handling so the same path doesn't
    // show up as two distinct workdirs across the UI.
    const target = resolve(bodyWorkdir ?? workdir);
    const err = await validateWorkdir(target);
    if (err) return c.json({ error: err }, 400);
    spawnOpts = { workdir: target, name: bodyName ?? undefined };
  } else {
    if (!isValidSid(resumeFrom)) {
      return c.json({ error: "invalid resume_from" }, 400);
    }
    const parentInfo = await resolveResumeParent(resumeFrom);
    if (parentInfo.kind === "unknown") {
      return c.json({ error: "unknown resume_from session" }, 404);
    }
    if (parentInfo.kind === "no_cc_sid") {
      // Parent session never reached CC's system/init — there's nothing
      // to resume against. Distinct 400 so the PWA can show a specific
      // error rather than "spawn failed".
      return c.json(
        {
          error:
            "resume_from parent never observed a cc session id — can't resume",
        },
        400,
      );
    }
    // Validate the inherited workdir before spawn — archived metadata
    // can outlive the directory it points at (e.g. operator deleted the
    // worktree). Without this check, Bun.spawn fails downstream and the
    // caller sees an opaque 500. Re-resolve so a parent stored as
    // /repo/.//worktree still validates against /repo/worktree.
    const parentWorkdir = resolve(parentInfo.workdir);
    const parentErr = await validateWorkdir(parentWorkdir);
    if (parentErr) {
      return c.json(
        { error: `resume_from parent workdir invalid: ${parentErr}` },
        400,
      );
    }
    spawnOpts = {
      // Spawn under the parent's workdir, not the server default. If the
      // operator restarted the server with a different --workdir, the
      // resumed subprocess still needs parent's cwd to match what the
      // transcript assumes.
      workdir: parentWorkdir,
      name: bodyName ?? undefined,
      parentCcSid: parentInfo.parentCcSid,
      parentOakridgeSid: resumeFrom,
    };
  }

  try {
    const session = await manager.create(spawnOpts);
    return c.json(session.snapshot());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: `spawn failed: ${msg}` }, 500);
  }
});

/**
 * Validates a workdir string for POST /sessions. Returns null if OK or a
 * human-readable error string for the 400 response. We require absolute
 * paths so the spawn cwd is unambiguous regardless of how the operator
 * launched the server, and verify existence + directory-ness so the
 * failure surfaces as a clear 400 instead of a downstream Bun.spawn
 * error. Operator input is trusted (this is a localhost/tailnet tool),
 * so no sandbox/allowlist beyond that.
 */
async function validateWorkdir(path: string): Promise<string | null> {
  if (!isAbsolute(path)) return "workdir must be an absolute path";
  try {
    const s = await stat(path);
    if (!s.isDirectory()) return "workdir is not a directory";
  } catch {
    return "workdir does not exist";
  }
  return null;
}

/**
 * Look up a resume parent's ccSid + workdir. Checks the live map first
 * (fast path) then falls back to parsing the on-disk JSONL. Returns a
 * tagged result so the POST handler can map each failure case to a
 * distinct status code.
 */
type ResumeParentResult =
  | { kind: "unknown" }
  | { kind: "no_cc_sid" }
  | { kind: "ok"; parentCcSid: string; workdir: string };

async function resolveResumeParent(sid: string): Promise<ResumeParentResult> {
  const live = manager.get(sid);
  if (live) {
    const ccSid = live.currentCcSid;
    if (!ccSid) return { kind: "no_cc_sid" };
    return { kind: "ok", parentCcSid: ccSid, workdir: live.workdir };
  }
  const jsonlPath = join(sessionsDir, `${sid}.jsonl`);
  let contents: string;
  try {
    contents = await readJsonlOrEmpty(jsonlPath);
  } catch (err) {
    // Same EACCES / I/O error surface as loadArchivedSnapshot — treat
    // as unknown rather than 500 the resume call, but log the cause so
    // an operator seeing an unexpected 404 on resume has a breadcrumb
    // (the alternative is indistinguishable from a genuinely unknown
    // sid).
    console.error(
      `cc-deck: failed to read parent jsonl ${jsonlPath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { kind: "unknown" };
  }
  if (!contents) return { kind: "unknown" };
  let parentCcSid: string | null = null;
  let parentWorkdir: string | null = null;
  for (const line of contents.split("\n")) {
    if (!line.trim()) continue;
    let evt: EnvelopeEvent;
    try {
      evt = JSON.parse(line) as EnvelopeEvent;
    } catch {
      continue;
    }
    const payload = (evt.payload ?? {}) as Record<string, unknown>;
    if (
      evt.type === "cc_session_id_observed" &&
      typeof payload.cc_session_id === "string"
    ) {
      parentCcSid = payload.cc_session_id;
    }
    if (evt.type === "session_started" && typeof payload.workdir === "string") {
      parentWorkdir = payload.workdir;
    }
    if (parentCcSid && parentWorkdir) break;
  }
  if (!parentCcSid) return { kind: "no_cc_sid" };
  // Fall back to server --workdir if the parent's session_started frame
  // is missing a workdir (very early truncated transcript). Same cwd
  // the operator is running under now; best-effort.
  return {
    kind: "ok",
    parentCcSid,
    workdir: parentWorkdir ?? workdir,
  };
}

app.delete("/sessions/:sid", async (c) => {
  const sid = c.req.param("sid");
  if (!isValidSid(sid)) return c.json({ error: "invalid sid" }, 400);
  // ?purge=true is a hard delete (drop map entry + delete JSONL). Without
  // it, the existing abort-only semantic is preserved so the PWA's Stop
  // button keeps the ended transcript visible. Treat any non-falsy value
  // as truthy ("1", "true", "yes") to match common URL convention.
  // Lowercase once so falsy variants like ?purge=False / FALSE / NO are
  // recognized — without this, mixed-case spellings would unexpectedly
  // trigger a hard delete.
  const purgeParam = c.req.query("purge")?.toLowerCase();
  const purge =
    purgeParam !== undefined &&
    purgeParam !== "" &&
    purgeParam !== "0" &&
    purgeParam !== "false" &&
    purgeParam !== "no" &&
    purgeParam !== "off";
  if (purge) {
    let removed: boolean;
    try {
      removed = await manager.remove(sid);
    } catch (err) {
      if (err instanceof RemoveFailedError) {
        // unlink failed for a non-ENOENT reason (EACCES/EBUSY/EIO/etc).
        // Surface as 500 so the client doesn't see a misleading
        // "removed:true" — the transcript may still be on disk and would
        // reappear after restart. The full message (with JSONL path) is
        // logged server-side; the response body intentionally omits the
        // path since the server runs on 0.0.0.0 (tailnet) and we don't
        // want to disclose filesystem layout to anyone who can hit it.
        console.error(`cc-deck: ${err.message}`);
        return c.json({ error: "purge failed" }, 500);
      }
      throw err;
    }
    if (!removed) return c.json({ error: "unknown session" }, 404);
    return c.json({ ok: true, removed: true });
  }
  const session = manager.get(sid);
  if (!session) return c.json({ error: "unknown session" }, 404);
  const code = await session.abort();
  return c.json({ ok: true, code });
});

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
