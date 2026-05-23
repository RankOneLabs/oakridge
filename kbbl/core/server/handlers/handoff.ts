import type { Hono } from "hono";
import { join } from "node:path";

import { isValidSid } from "./per-sid";

export interface HandoffRouteDeps {
  /**
   * Absolute path to the directory where runCompact writes the handoff
   * markdown — `<dataDir>/handoffs`. Threaded explicitly rather than read
   * from a derived constant so test wiring + a future relocation don't
   * have to chase a hardcoded sibling-of-sessions assumption.
   */
  handoffsDir: string;
}

/**
 * `GET /:sid/handoff` — returns the markdown body of the handoff doc the
 * compaction lifecycle persisted at `kbbl/data/handoffs/<sid>.md`. The
 * PWA's CompactedBanner consumes this when the operator opens a session
 * whose endReason is "compacted".
 *
 * Status mapping:
 *   200 — file present, body is `text/markdown; charset=utf-8`
 *   400 — sid did not match the UUID-v4 shape (path-traversal guard)
 *   404 — sid is well-formed but no `<sid>.md` exists on disk (the
 *         session never compacted, or compaction failed before the
 *         handoff write succeeded)
 */
export function mountHandoffRoutes(app: Hono, deps: HandoffRouteDeps): void {
  const { handoffsDir } = deps;

  app.get("/:sid/handoff", async (c) => {
    const sid = c.req.param("sid");
    // Validated against the same UUID-v4 regex as /:sid/events. Without
    // this an URL-encoded traversal like `..%2F..%2Fetc%2Fpasswd` would
    // join into handoffsDir and read arbitrary files the server has
    // access to — the handoff dir holds operator-private context that
    // should not leak via a malformed URL.
    if (!isValidSid(sid)) {
      return c.json({ error: "invalid sid" }, 400);
    }
    const path = join(handoffsDir, `${sid}.md`);
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return c.json({ error: "handoff not found" }, 404);
    }
    const body = await file.text();
    return c.body(body, 200, {
      "content-type": "text/markdown; charset=utf-8",
      // Compaction handoffs are immutable once written (runCompact never
      // overwrites; the operator cannot re-compact a session). Allow the
      // PWA to cache them for the session — a hard refresh still reloads.
      "cache-control": "private, max-age=300",
    });
  });
}
