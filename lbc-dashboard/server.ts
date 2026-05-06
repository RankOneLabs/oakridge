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
import { open, stat } from "node:fs/promises";
import { join } from "node:path";

import {
  getCellDetail,
  listCells,
  readArtifact,
  readCommits,
  readEvalScores,
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

app.get("/api/cells/:cellId/eval", async (c) => {
  const cellId = c.req.param("cellId");
  const cellDir = await resolveCellDir(cellId);
  if (cellDir === null) return c.json({ error: "not found" }, 404);
  // ``scores`` is either a non-empty ``EvalScore[]`` or ``null``.
  // ``null`` means no scores were persisted for this cell — either
  // no grader was wired, or the grader ran but produced no scores.
  // The harness writer skips zero-score sidecars and ``readEvalScores``
  // folds any empty/all-malformed list back to ``null``, so an empty
  // array never reaches the wire.
  const scores = await readEvalScores(cellId);
  return c.json({ scores });
});

app.get("/api/cells/:cellId/commits", async (c) => {
  // Validate the cellId at the boundary so an invalid id 404s
  // instead of returning 200 [] like the cell exists with no
  // commits — that's a different state (cell exists, hasn't
  // committed yet) and the API distinction matters.
  const cellId = c.req.param("cellId");
  const cellDir = await resolveCellDir(cellId);
  if (cellDir === null) return c.json({ error: "not found" }, 404);
  const commits = await readCommits(cellId);
  return c.json({ commits });
});

/**
 * SSE stream for one cell. Honors ``Last-Event-Id`` on reconnect so
 * a brief disconnect doesn't replay the full backlog. Tails the
 * events.jsonl incrementally — tracks the byte offset it last read
 * and only reads the appended portion each tick, parsing only the
 * new lines.
 *
 * Previous mtime-cache version still re-parsed the whole file on
 * every change; over an N-event cell that was O(N²) cumulative work
 * (one full re-parse per append). Incremental tailing is O(N) total.
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
  // ``id:`` fields. Skip events whose id is <= resumeAfter so a brief
  // disconnect doesn't replay the backlog into the UI.
  const resumeAfter = Number.isFinite(parsedResumeId)
    ? parsedResumeId
    : -1;
  const eventsPath = join(cellDir, "events.jsonl");
  return streamSSE(c, async (stream) => {
    let sentCount = 0;
    let lastSizeBytes = 0;
    let leftover = "";
    const heartbeat = setInterval(() => {
      stream.write(": ping\n\n").catch(() => {});
    }, 15000);
    try {
      while (!clientSignal.aborted) {
        const result = await readNewLines(
          eventsPath,
          lastSizeBytes,
          leftover,
        );
        lastSizeBytes = result.nextOffset;
        leftover = result.nextLeftover;
        for (const line of result.newLines) {
          let evt: unknown;
          try {
            evt = JSON.parse(line);
          } catch {
            // Skip malformed line; don't bump sentCount. The
            // sidebar's event_count uses the same parsed-only
            // accounting (see store.ts::summarize).
            continue;
          }
          if (sentCount > resumeAfter) {
            await stream.writeSSE({
              event: "message",
              data: JSON.stringify(evt),
              id: String(sentCount),
            });
          }
          sentCount += 1;
        }
        // 250ms is fine UX latency for events that fire every few
        // seconds; tighten if a faster harness emerges.
        await new Promise((r) => setTimeout(r, 250));
      }
    } finally {
      clearInterval(heartbeat);
    }
  });
});

/**
 * Read appended bytes since the last offset. Carries a UTF-8
 * leftover string across calls because the tail of one read may not
 * end at a complete line.
 *
 * Treats file-truncation (size shrunk) as a re-create: resets to
 * offset 0 + empty leftover. Caller should reset its sent-counter
 * if it cares (the SSE handler doesn't — sentCount keeps moving
 * forward and the client's Last-Event-Id resume just picks up
 * wherever).
 */
async function readNewLines(
  path: string,
  fromBytes: number,
  leftover: string,
): Promise<{ newLines: string[]; nextOffset: number; nextLeftover: string }> {
  let st;
  try {
    st = await stat(path);
  } catch {
    // File doesn't exist yet — brand new cell. Nothing to read.
    return { newLines: [], nextOffset: fromBytes, nextLeftover: leftover };
  }
  let startOffset = fromBytes;
  let carry = leftover;
  if (st.size < startOffset) {
    // Truncated/replaced. Re-read from the beginning.
    startOffset = 0;
    carry = "";
  }
  if (st.size === startOffset) {
    return { newLines: [], nextOffset: startOffset, nextLeftover: carry };
  }
  const len = st.size - startOffset;
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, startOffset);
    const text = carry + buf.toString("utf-8");
    const lastNewline = text.lastIndexOf("\n");
    if (lastNewline === -1) {
      // No complete line yet; carry everything to the next tick.
      return { newLines: [], nextOffset: st.size, nextLeftover: text };
    }
    const consumed = text.slice(0, lastNewline);
    const nextLeftover = text.slice(lastNewline + 1);
    const newLines = consumed.split("\n").filter((l) => l.trim());
    return { newLines, nextOffset: st.size, nextLeftover };
  } finally {
    await fh.close();
  }
}

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
