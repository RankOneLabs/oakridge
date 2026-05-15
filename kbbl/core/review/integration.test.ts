import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../db/test-db";
import { reviewRegistry } from "./registry";
import { reviewEvents, type ReviewEventMap } from "./events";
import { mountReviewFreezeRoutes } from "../server/handlers/review-freeze";
import { mountReviewAtomsRoutes } from "../server/handlers/review-atoms";
import { mountReviewThreadsRoutes } from "../server/handlers/review-threads";

let db: Database;
let app: Hono;

beforeEach(() => {
  db = openTestDb();
  reviewRegistry.register("test", {
    validateAnchor: (a) => a === null || a.startsWith("section.") || `bad anchor ${a}`,
    exists: () => true,
  });
  app = new Hono();
  mountReviewFreezeRoutes(app, { db });
  mountReviewAtomsRoutes(app, { db });
  mountReviewThreadsRoutes(app, { db });
});

afterEach(() => {
  db.close();
});

function post(path: string, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patch(path: string, body: unknown) {
  return app.request(path, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("review primitive — full happy path", () => {
  test("edit → thread → ping → freeze → 409 on next edit → unfreeze → edit succeeds; all events fire", async () => {
    const fired: Partial<Record<keyof ReviewEventMap, unknown[]>> = {};
    const unsubs: (() => void)[] = [];

    const track = <K extends keyof ReviewEventMap>(event: K) => {
      const list: ReviewEventMap[K][] = [];
      fired[event] = list as unknown[];
      unsubs.push(
        reviewEvents.subscribe(event, (p) => {
          (list as ReviewEventMap[K][]).push(p);
        }),
      );
    };

    track("atom_edit.applied");
    track("thread.created");
    track("thread.message_added");
    track("thread.resolved");
    track("artifact.frozen");
    track("artifact.reopened");
    track("thread.ping_received");

    try {
    // --- edit 1: first edit (prev_value must be null) ---
    const e1Res = await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-1",
      anchor: "section.intro",
      prev_value: null,
      new_value: "Hello world",
      author: "alice",
    });
    expect(e1Res.status).toBe(201);
    const e1 = (await e1Res.json()) as { id: string; new_value: string };
    expect(e1.new_value).toBe("Hello world");

    // --- edit 2: correct prev_value ---
    const e2Res = await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-1",
      anchor: "section.intro",
      prev_value: "Hello world",
      new_value: "Hello revised",
      author: "alice",
    });
    expect(e2Res.status).toBe(201);

    // --- stale prev_value rejected ---
    const staleRes = await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-1",
      anchor: "section.intro",
      prev_value: "Hello world", // stale — current is now "Hello revised"
      new_value: "Should not land",
      author: "alice",
    });
    expect(staleRes.status).toBe(409);
    const staleBody = (await staleRes.json()) as { error: string; current_value: string };
    expect(staleBody.error).toBe("stale prev_value");
    expect(staleBody.current_value).toBe("Hello revised");

    // --- invalid anchor rejected ---
    const badAnchorRes = await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-1",
      anchor: "invalid",
      prev_value: null,
      new_value: "X",
      author: "alice",
    });
    expect(badAnchorRes.status).toBe(400);
    const badAnchorBody = (await badAnchorRes.json()) as { error: string };
    expect(badAnchorBody.error).toBe("bad anchor invalid");

    // --- unregistered type rejected ---
    const unregRes = await post("/atoms/edits", {
      target_type: "unknown",
      target_id: "art-1",
      anchor: null,
      prev_value: null,
      new_value: "X",
      author: "alice",
    });
    expect(unregRes.status).toBe(409);
    expect(((await unregRes.json()) as { error: string }).error).toBe("unregistered target_type");

    // --- create thread ---
    const tRes = await post("/threads", {
      target_type: "test",
      target_id: "art-1",
      anchor: "section.intro",
      author: "bob",
    });
    expect(tRes.status).toBe(201);
    const thread = (await tRes.json()) as { id: string; status: string };
    expect(thread.status).toBe("open");
    const threadId = thread.id;

    // --- list threads ---
    const listTRes = await app.request("/threads?target_type=test&target_id=art-1");
    expect(listTRes.status).toBe(200);
    const threads = (await listTRes.json()) as unknown[];
    expect(threads).toHaveLength(1);

    // --- add message ---
    const msgRes = await post(`/threads/${threadId}/messages`, {
      body: "LGTM",
      author: "bob",
    });
    expect(msgRes.status).toBe(201);
    const msg = (await msgRes.json()) as { id: string; body: string };
    expect(msg.body).toBe("LGTM");

    // --- list messages ---
    const listMRes = await app.request(`/threads/${threadId}/messages`);
    expect(listMRes.status).toBe(200);
    const messages = (await listMRes.json()) as unknown[];
    expect(messages).toHaveLength(1);

    // --- ping ---
    const pingRes = await post(`/threads/${threadId}/ping`, {});
    expect(pingRes.status).toBe(202);

    // --- resolve thread ---
    const resolveRes = await patch(`/threads/${threadId}`, { status: "resolved" });
    expect(resolveRes.status).toBe(200);
    const resolved = (await resolveRes.json()) as { status: string };
    expect(resolved.status).toBe("resolved");

    // --- double-resolve rejected ---
    const doubleResolveRes = await patch(`/threads/${threadId}`, { status: "resolved" });
    expect(doubleResolveRes.status).toBe(409);

    // --- freeze ---
    const freezeRes = await post("/review/freeze", { target_type: "test", target_id: "art-1" });
    expect(freezeRes.status).toBe(200);

    // --- edit after freeze: 409 ---
    const frozenEditRes = await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-1",
      anchor: "section.intro",
      prev_value: "Hello revised",
      new_value: "Should not land",
      author: "alice",
    });
    expect(frozenEditRes.status).toBe(409);
    expect(((await frozenEditRes.json()) as { error: string }).error).toBe("artifact is frozen");

    // --- thread creation after freeze: 409 ---
    const frozenThreadRes = await post("/threads", {
      target_type: "test",
      target_id: "art-1",
      author: "carol",
    });
    expect(frozenThreadRes.status).toBe(409);

    // --- messages allowed on frozen artifact ---
    const frozenMsgRes = await post(`/threads/${threadId}/messages`, {
      body: "Approved but noting this edge case",
      author: "carol",
    });
    expect(frozenMsgRes.status).toBe(201);

    // --- unfreeze ---
    const unfreezeRes = await post("/review/unfreeze", { target_type: "test", target_id: "art-1" });
    expect(unfreezeRes.status).toBe(200);

    // --- edit succeeds after unfreeze ---
    const e3Res = await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-1",
      anchor: "section.intro",
      prev_value: "Hello revised",
      new_value: "Post-unfreeze edit",
      author: "alice",
    });
    expect(e3Res.status).toBe(201);

    // --- verify all events fired ---
    expect((fired["atom_edit.applied"] as unknown[]).length).toBe(3); // e1, e2, post-unfreeze
    expect((fired["thread.created"] as unknown[]).length).toBe(1);
    expect((fired["thread.message_added"] as unknown[]).length).toBe(2); // before + after freeze
    expect((fired["thread.resolved"] as unknown[]).length).toBe(1);
    expect((fired["artifact.frozen"] as unknown[]).length).toBe(1);
    expect((fired["artifact.reopened"] as unknown[]).length).toBe(1);
    expect((fired["thread.ping_received"] as unknown[]).length).toBe(1);

    // verify event payloads have correct target routing fields
    const editEvent = (fired["atom_edit.applied"] as Array<{ target_type: string; target_id: string; anchor: string | null }>)[0]!;
    expect(editEvent.target_type).toBe("test");
    expect(editEvent.target_id).toBe("art-1");
    expect(editEvent.anchor).toBe("section.intro");

    const pingEvent = (fired["thread.ping_received"] as Array<{ thread_id: string; anchor: string | null }>)[0]!;
    expect(pingEvent.thread_id).toBe(threadId);
    expect(pingEvent.anchor).toBe("section.intro");

    } finally {
      for (const unsub of unsubs) unsub();
    }
  });

  test("GET /atoms/edits returns edit log ordered by created_at ASC", async () => {
    await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-2",
      anchor: null,
      prev_value: null,
      new_value: "v1",
      author: "alice",
    });
    await post("/atoms/edits", {
      target_type: "test",
      target_id: "art-2",
      anchor: null,
      prev_value: "v1",
      new_value: "v2",
      author: "alice",
    });

    const res = await app.request("/atoms/edits?target_type=test&target_id=art-2");
    expect(res.status).toBe(200);
    const edits = (await res.json()) as Array<{ new_value: string }>;
    expect(edits).toHaveLength(2);
    expect(edits[0]!.new_value).toBe("v1");
    expect(edits[1]!.new_value).toBe("v2");
  });

  test("freeze is idempotent — second freeze emits no event", async () => {
    const frozenEvents: unknown[] = [];
    const unsub = reviewEvents.subscribe("artifact.frozen", (p) => frozenEvents.push(p));

    await post("/review/freeze", { target_type: "test", target_id: "idem-1" });
    await post("/review/freeze", { target_type: "test", target_id: "idem-1" });
    expect(frozenEvents).toHaveLength(1);

    unsub();
  });
});
