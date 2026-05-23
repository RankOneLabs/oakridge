import { describe, expect, test } from "bun:test";
import { Hono } from "hono";

import { ArtifactEventBus } from "../../stream/artifact-event-bus";
import { mountArtifactStreamRoutes } from "./artifact-stream";

function buildApp(): { app: Hono; bus: ArtifactEventBus } {
  const bus = new ArtifactEventBus();
  const app = new Hono();
  mountArtifactStreamRoutes(app, { bus });
  return { app, bus };
}

async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (buf: string) => boolean,
  timeoutMs = 1000,
): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((r) =>
        setTimeout(() => r({ done: true, value: undefined }), remaining),
      ),
    ]);
    if (result.done) break;
    buf += decoder.decode(result.value, { stream: true });
    if (predicate(buf)) return buf;
  }
  throw new Error(`readUntil timed out. Buffered: ${JSON.stringify(buf)}`);
}

describe("GET /artifact-stream", () => {
  test("returns 400 when target_type or target_id is missing", async () => {
    const { app } = buildApp();
    const res = await app.fetch(new Request("http://kbbl.test/artifact-stream"));
    expect(res.status).toBe(400);
  });

  test("opens an SSE stream and forwards published events as named SSE frames", async () => {
    const { app, bus } = buildApp();
    const controller = new AbortController();

    const res = await app.fetch(
      new Request(
        "http://kbbl.test/artifact-stream?target_type=plan&target_id=plan-1",
        { signal: controller.signal },
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.body).not.toBeNull();

    const reader = res.body!.getReader();
    try {
      await readUntil(reader, (b) => b.includes(": ready"));

      bus.publish(
        "plan",
        "plan-1",
        "atom_edit.applied",
        {
          id: "edit-1",
          target_type: "plan",
          target_id: "plan-1",
          anchor: "goal",
          prior_value: null,
          new_value: "hello",
          author: "tester",
          created_at: "2026-05-17T00:00:00Z",
        },
        "2026-05-17T00:00:00Z",
      );

      const frame = await readUntil(reader, (b) =>
        b.includes("event: atom_edit.applied"),
      );

      // Verify the wire format: `event: <name>` line + `data: <json>` line.
      // The client uses addEventListener(<name>, ...) and JSON.parse(e.data),
      // so the data payload must be the inner event data directly, not
      // wrapped in { event, data, ts }.
      expect(frame).toContain("event: atom_edit.applied");
      const dataMatch = frame.match(/data: (.+)/);
      expect(dataMatch).not.toBeNull();
      const parsed = JSON.parse(dataMatch![1]);
      expect(parsed).toMatchObject({
        id: "edit-1",
        new_value: "hello",
        prior_value: null,
        created_at: "2026-05-17T00:00:00Z",
      });
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });

  test("replays missed events when last_event_id is provided", async () => {
    const { app, bus } = buildApp();

    // Publish two events before any subscriber connects.
    bus.publish(
      "plan",
      "plan-2",
      "atom_edit.applied",
      {
        id: "edit-a",
        target_type: "plan",
        target_id: "plan-2",
        anchor: null,
        prior_value: null,
        new_value: "a",
        author: "tester",
        created_at: "2026-05-17T00:00:00Z",
      },
      "2026-05-17T00:00:00Z",
    );
    bus.publish(
      "plan",
      "plan-2",
      "thread.created",
      {
        id: "thread-b",
        target_type: "plan",
        target_id: "plan-2",
        anchor: null,
        author: null,
        status: "open",
        created_at: "2026-05-17T00:00:01Z",
      },
      "2026-05-17T00:00:01Z",
    );

    const controller = new AbortController();
    const res = await app.fetch(
      new Request(
        "http://kbbl.test/artifact-stream?target_type=plan&target_id=plan-2&last_event_id=0",
        { signal: controller.signal },
      ),
    );

    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    try {
      const buf = await readUntil(reader, (b) =>
        b.includes("event: thread.created"),
      );

      // Both replayed events should appear, with SSE ids 1 and 2.
      expect(buf).toContain("event: atom_edit.applied");
      expect(buf).toContain("event: thread.created");
      expect(buf).toMatch(/id: 1\b/);
      expect(buf).toMatch(/id: 2\b/);
    } finally {
      controller.abort();
      await reader.cancel().catch(() => {});
    }
  });
});
