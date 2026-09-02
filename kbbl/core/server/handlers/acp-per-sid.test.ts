// Request validation for the §14 browser routes. Semantics (idempotency,
// busy, permissions) are covered at the service level and through the
// DBOS contract suite; these tests pin the HTTP validation surface.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { makeAcpTestService } from "../../acp/test-harness";
import { mountAcpPerSidRoutes } from "./acp-per-sid";

const tmpRoot = mkdtempSync(join(tmpdir(), "acp-per-sid-"));
const harness = makeAcpTestService({ stateDir: join(tmpRoot, "state") });
const app = new Hono();
mountAcpPerSidRoutes(app, { acp: harness.service });

afterAll(async () => {
  await harness.service.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001";

async function postInput(body: unknown): Promise<Response> {
  return app.request(`/sessions/${SID}/input`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /sessions/:sid/input validation", () => {
  test("an empty client_message_id is rejected, not collapsed onto a shared turn key", async () => {
    const res = await postInput({ text: "hello", client_message_id: "" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("client_message_id");
  });

  test("a non-string client_message_id is rejected", async () => {
    const res = await postInput({ text: "hello", client_message_id: 7 });
    expect(res.status).toBe(400);
  });

  test("empty text is rejected", async () => {
    const res = await postInput({ text: "   " });
    expect(res.status).toBe(400);
  });

  test("a valid body for an unknown session reaches the service and 404s", async () => {
    const res = await postInput({ text: "hello", client_message_id: "msg-1" });
    expect(res.status).toBe(404);
  });
});

test("cold session stream flushes readiness and releases its child after disconnect", async () => {
  const stateDir = join(tmpRoot, "cold-stream-state");
  const first = makeAcpTestService({ stateDir });
  const created = await first.service.createSession({
    initial_prompt: "remember this",
    workdir: tmpRoot,
    runtime: "fake",
  });
  if (!created.ok) throw new Error(`create failed: ${created.error.code}`);
  const sid = created.value.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();

  const cold = makeAcpTestService({
    stateDir,
    db: first.db,
    behavior: "delayed_load",
    delayMs: 600,
  });
  const coldApp = new Hono();
  mountAcpPerSidRoutes(coldApp, { acp: cold.service });
  const requestController = new AbortController();
  const response = await coldApp.fetch(
    new Request(`http://kbbl.test/sessions/${sid}/stream`, {
      signal: requestController.signal,
    }),
  );
  const reader = response.body?.getReader();
  if (!reader) throw new Error("stream response has no body");

  try {
    const firstChunk = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("readiness frame timed out")), 250),
      ),
    ]);
    expect(new TextDecoder().decode(firstChunk.value)).toContain(": ready");
  } finally {
    requestController.abort();
    await reader.cancel().catch(() => {});
  }

  // Wait past the fake agent's load delay: a cancelled single-flight must
  // not install a controller after the request has already disappeared.
  await new Promise((resolve) => setTimeout(resolve, 800));
  const deadline = Date.now() + 3000;
  while (cold.registry.liveCount() !== 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(cold.registry.liveCount()).toBe(0);
  await cold.service.shutdown();
}, 15000);
