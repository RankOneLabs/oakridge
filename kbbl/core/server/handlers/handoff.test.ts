import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mountHandoffRoutes } from "./handoff";

let tmpRoot: string;
let handoffsDir: string;

const VALID_SID = "deadbeef-cafe-4abc-8def-aaaaaaaaaaaa";

function buildApp(): Hono {
  const app = new Hono();
  mountHandoffRoutes(app, { handoffsDir });
  return app;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-handoff-test-"));
  handoffsDir = join(tmpRoot, "handoffs");
  mkdirSync(handoffsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /:sid/handoff", () => {
  test("returns 200 with markdown body when the file exists", async () => {
    const md = "# handoff\n\n## Goal\nFinish the build plan.\n";
    writeFileSync(join(handoffsDir, `${VALID_SID}.md`), md, "utf8");
    const app = buildApp();

    const res = await app.fetch(
      new Request(`http://kbbl.test/${VALID_SID}/handoff`),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await res.text()).toBe(md);
  });

  test("returns 404 when the sid is well-formed but the file is absent", async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request(`http://kbbl.test/${VALID_SID}/handoff`),
    );

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "handoff not found" });
  });

  test("returns 400 when the sid is not a UUID v4", async () => {
    const app = buildApp();

    const res = await app.fetch(
      new Request("http://kbbl.test/not-a-uuid/handoff"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid sid" });
  });

  test("rejects URL-encoded path traversal at the sid validator (no FS read)", async () => {
    // ..%2F..%2Fetc%2Fpasswd — the validator rejects on shape before any
    // join() call, so this should 400 even if /etc/passwd happens to be
    // readable to the test process. Belt-and-suspenders against a future
    // refactor that swaps the validator out.
    const app = buildApp();

    const res = await app.fetch(
      new Request("http://kbbl.test/..%2F..%2Fetc%2Fpasswd/handoff"),
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid sid" });
  });
});
