import { expect, test } from "bun:test";
import { createInvalidationEventApp, selectBaselineCursor } from "../src/http/invalidation-events";

/** Read frames until `predicate` is satisfied or the stream runs dry. */
const readUntil = async (body: ReadableStream<Uint8Array> | null, predicate: (text: string) => boolean): Promise<string> => {
  const reader = body?.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    for (let frame = 0; frame < 20; frame += 1) {
      const chunk = await reader?.read();
      if (!chunk || chunk.done) break;
      text += decoder.decode(chunk.value);
      if (predicate(text)) break;
    }
  } finally {
    await reader?.cancel();
  }
  return text;
};

test("operator event stream flushes immediately before waiting for changes", async () => {
  const app = createInvalidationEventApp({ current_cursor: async () => "cursor-1", poll_interval_ms: 60_000 });
  const response = await app.request("/events");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  expect(await readUntil(response.body, (text) => text.includes(": ready"))).toContain(": ready");
});

test("an idle stream sends heartbeat comments so intermediaries see traffic", async () => {
  const app = createInvalidationEventApp({ current_cursor: async () => "unchanged", poll_interval_ms: 1, heartbeat_interval_ms: 2 });
  const response = await app.request("/events");
  expect(await readUntil(response.body, (text) => text.includes(": ping"))).toContain(": ping");
});

test("a change is announced as an invalidate carrying the new cursor as its event id", async () => {
  let cursor = "before";
  const app = createInvalidationEventApp({ current_cursor: async () => cursor, poll_interval_ms: 1, heartbeat_interval_ms: 60_000 });
  const response = await app.request("/events");
  cursor = "after";
  const text = await readUntil(response.body, (frames) => frames.includes("event: invalidate"));
  expect(text).toContain("event: invalidate");
  expect(text).toContain("id: after");
});

test("a reconnect resuming from a stale event id is told to catch up rather than re-baselined", async () => {
  const app = createInvalidationEventApp({ current_cursor: async () => "current", poll_interval_ms: 1, heartbeat_interval_ms: 60_000 });
  const response = await app.request("/events", { headers: { "last-event-id": "stale" } });
  expect(await readUntil(response.body, (text) => text.includes("event: invalidate"))).toContain("event: invalidate");
});

test("a fresh connection baselines on the live cursor and an absent header never wins over it", () => {
  expect(selectBaselineCursor(undefined, "live")).toBe("live");
  expect(selectBaselineCursor("", "live")).toBe("live");
  expect(selectBaselineCursor("resumed", "live")).toBe("resumed");
});
