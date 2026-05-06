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
import { join } from "node:path";

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
 * SSE stream for one cell. Replays existing events from
 * events.jsonl, then polls the file mtime every 250ms for new
 * events. Closes when the client disconnects.
 *
 * Polling rather than fs.watch because events.jsonl is appended-to
 * incrementally; we just track the line count we've sent and read
 * any new ones each tick.
 */
app.get("/api/cells/:cellId/events", async (c) => {
  const cellId = c.req.param("cellId");
  const cellDir = await resolveCellDir(cellId);
  if (cellDir === null) return c.json({ error: "not found" }, 404);
  const clientSignal = c.req.raw.signal;
  return streamSSE(c, async (stream) => {
    let sentCount = 0;
    const heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15000);
    try {
      while (!clientSignal.aborted) {
        const events = await readEvents(cellDir);
        for (let i = sentCount; i < events.length; i++) {
          await stream.writeSSE({
            event: "message",
            data: JSON.stringify(events[i]),
            id: String(i),
          });
        }
        sentCount = events.length;
        // Cheap polling tick. 250ms is fine UX latency for events
        // that fire every few seconds; tighten if a faster harness
        // emerges.
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
const pwaDist = join(import.meta.dirname, "pwa", "dist");
app.use("/*", serveStatic({ root: pwaDist }));
app.get("/", serveStatic({ path: join(pwaDist, "index.html") }));

// --- entry -------------------------------------------------------------

const port = Number(process.env.LBC_DASHBOARD_PORT ?? "8765");

console.log(`[lbc-dashboard] run root: ${resolveRunRoot()}`);
console.log(`[lbc-dashboard] listening on http://localhost:${port}`);

export default {
  port,
  fetch: app.fetch,
};
