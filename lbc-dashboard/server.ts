/**
 * lbc-dashboard server entry.
 *
 * Hono app exposing read-only endpoints over legit-biz-club's
 * .run/<ts>/<target>/<condition>/ cell sidecars. SSE for live event
 * streams; plain JSON for cell list, artifact, commits.
 *
 * The Python harness writes everything to disk; this server just
 * reads. No write surface — operator triggers cells from the
 * terminal.
 *
 * Default port 8765 (mnemonic: "lbc" loosely keyed). Override with
 * LBC_DASHBOARD_PORT.
 */
import { serveStatic } from "hono/bun";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import type { CellEvent } from "./src/store";
import {
  getCellDetail,
  listCells,
  readArtifact,
  readCommits,
  readEvents,
  resolveCellDir,
  resolveRunRoot,
} from "./src/store";

const app = new Hono();

// --- API ---------------------------------------------------------------

app.get("/api/cells", async (c) => {
  const cells = await listCells();
  return c.json({ cells });
});

app.get("/api/cells/:cellId", async (c) => {
  const detail = await getCellDetail(c.req.param("cellId"));
  if (detail === null) return c.json({ error: "not found" }, 404);
  return c.json(detail);
});

app.get("/api/cells/:cellId/artifact", async (c) => {
  const content = await readArtifact(c.req.param("cellId"));
  if (content === null) return c.json({ error: "not found" }, 404);
  return c.json({ content });
});

app.get("/api/cells/:cellId/commits", async (c) => {
  const commits = await readCommits(c.req.param("cellId"));
  return c.json({ commits });
});

/**
 * SSE stream for one cell. Honors ``Last-Event-Id`` on reconnect so
 * a brief disconnect doesn't replay the full backlog. Caches the
 * parsed events list keyed by the file's mtime so the 250ms polling
 * loop doesn't re-read a multi-KB file on every tick when nothing
 * has changed.
 */
app.get("/api/cells/:cellId/events", async (c) => {
  const cellId = c.req.param("cellId");
  const cellDir = await resolveCellDir(cellId);
  if (cellDir === null) return c.json({ error: "not found" }, 404);
  const clientSignal = c.req.raw.signal;
  const lastEventIdHeader = c.req.header("last-event-id");
  const parsedResumeId = lastEventIdHeader
    ? Number(lastEventIdHeader)
    : NaN;
  // Browsers auto-send Last-Event-Id when the prior connection emitted
  // ``id:`` fields. Resume from the next event rather than replaying
  // the backlog into the UI.
  const initialSent = Number.isFinite(parsedResumeId)
    ? parsedResumeId + 1
    : 0;
  return streamSSE(c, async (stream) => {
    let sentCount = initialSent;
    let cachedEvents: CellEvent[] = [];
    let lastMtimeMs = -1;
    const eventsPath = join(cellDir, "events.jsonl");
    const heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15000);
    try {
      while (!clientSignal.aborted) {
        // mtime-keyed cache: only re-parse the JSONL when the file
        // has actually changed since the last tick. As event logs
        // grow this is the difference between O(n) per-tick disk +
        // CPU and O(1) on the steady-state.
        let mtimeMs = -1;
        try {
          const st = await stat(eventsPath);
          mtimeMs = st.mtimeMs;
        } catch {
          // File doesn't exist yet — first tick of a brand new cell.
        }
        if (mtimeMs !== lastMtimeMs) {
          cachedEvents = await readEvents(cellDir);
          lastMtimeMs = mtimeMs;
        }
        for (let i = sentCount; i < cachedEvents.length; i++) {
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify(cachedEvents[i]),
            id: String(i),
          });
        }
        sentCount = Math.max(sentCount, cachedEvents.length);
        // 250ms is fine UX latency for events that fire every few
        // seconds; tighten if a faster harness emerges.
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      clearInterval(heartbeat);
    }
  });
});

// --- static (built PWA) -----------------------------------------------

// In dev (`bun run dev:pwa`) Vite serves the PWA on its own port and
// proxies API requests here. In prod (`bun run build:pwa && bun start`)
// the built static bundle is served from this Hono process directly.
//
// Single registration with rewriteRequestPath mapping `/` →
// `/index.html` (mirrors kbbl's pattern). The previous `app.get("/")`
// fallback after the wildcard was unreachable: the wildcard
// middleware matches `/` first and handles it. Explicit rewrite is
// less brittle than relying on serveStatic's default index lookup.
const pwaDist = join(import.meta.dirname, "pwa", "dist");
app.use(
  "/*",
  serveStatic({
    root: pwaDist,
    rewriteRequestPath: (path) => (path === "/" ? "/index.html" : path),
  }),
);

// --- entry -------------------------------------------------------------

function parsePort(raw: string | undefined): number {
  const n = Number(raw ?? "8765");
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(
      `[lbc-dashboard] invalid LBC_DASHBOARD_PORT=${JSON.stringify(raw)} ` +
        "— must be an integer in [1, 65535]",
    );
    process.exit(1);
  }
  return n;
}

const port = parsePort(process.env.LBC_DASHBOARD_PORT);

console.log(`[lbc-dashboard] run root: ${resolveRunRoot()}`);
console.log(`[lbc-dashboard] listening on http://127.0.0.1:${port}`);

// Bind to loopback by default — the dashboard has no auth and is
// intended for the operator's own machine. Bun's default would bind
// to 0.0.0.0 and expose the port on any LAN interface; that's a
// trust-model leak the README explicitly avoids by saying
// "localhost-only by design." Override LBC_DASHBOARD_HOST to bind
// elsewhere (e.g., "0.0.0.0" on a Tailnet-only host where
// every interface is trusted).
export default {
  port,
  hostname: process.env.LBC_DASHBOARD_HOST ?? "127.0.0.1",
  fetch: app.fetch,
};
