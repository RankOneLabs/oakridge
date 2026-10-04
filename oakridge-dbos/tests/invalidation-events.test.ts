import { expect, test } from "bun:test";
import { createInvalidationEventApp, selectBaselineCursor } from "../src/http/invalidation-events";
import type { RunEvent } from "../src/domain/run-event";
import type { WorkflowRunId } from "../src/domain/primitives";

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

const runEvent = (sequence: string): RunEvent => ({
  sequence,
  transition_id: "00000000-0000-4000-8000-000000000002" as import("../src/domain/primitives").RunTransitionId,
  run_id: "00000000-0000-4000-8000-000000000001" as WorkflowRunId,
  owner: { kind: "run", id: "00000000-0000-4000-8000-000000000001" as WorkflowRunId },
  launch_reason: "operator", prior_owner_version: 3, resulting_owner_version: 4,
  operation: "run_cancelled", effect: { kind: "unrecognized", effect_kind: "run_cancelled" },
  effect_workflow_id: "v15-effect:run:00000000-0000-4000-8000-000000000001:4",
  actor: "operator", occurred_at: "2026-09-26T12:00:00.000Z",
});

test("a numeric Last-Event-ID replays only later run events and marks them replayed", async () => {
  const events = [runEvent("10"), runEvent("11"), runEvent("12")];
  const app = createInvalidationEventApp({ current_cursor: async () => "cursor:12", poll_interval_ms: 60_000,
    list_run_events: async (after) => events.filter((event) => BigInt(event.sequence) > BigInt(after ?? "0")) });
  const response = await app.request("/events", { headers: { "last-event-id": "10" } });
  const text = await readUntil(response.body, (frames) => frames.includes('"sequence":"12"'));
  expect(text.match(/event: run_event/g)).toHaveLength(2);
  expect(text).not.toContain('"sequence":"10"');
  expect(text).toContain('"replayed":true');
});

test("a reconnect extracts the run sequence from an invalidate frame id before falling back to live", async () => {
  const events = [runEvent("10"), runEvent("11"), runEvent("12")];
  const app = createInvalidationEventApp({ current_cursor: async () => "cursor:12", poll_interval_ms: 60_000,
    list_run_events: async (after) => events.filter((event) => BigInt(event.sequence) > BigInt(after ?? "0")) });
  const response = await app.request("/events", { headers: { "last-event-id": "dbos:artifacts:10" } });
  const text = await readUntil(response.body, (frames) => frames.includes('"sequence":"12"'));
  expect(text.match(/event: run_event/g)).toHaveLength(2);
  expect(text).toContain('"sequence":"11"');
  expect(text).toContain('"sequence":"12"');
});

test("a fresh connection does not replay historical run events", async () => {
  let listCalls = 0;
  const app = createInvalidationEventApp({ current_cursor: async () => "cursor:12", poll_interval_ms: 60_000,
    list_run_events: async () => { listCalls += 1; return [runEvent("12")]; } });
  const response = await app.request("/events");
  const text = await readUntil(response.body, (frames) => frames.includes(": ready"));
  expect(text).not.toContain("event: run_event");
  expect(listCalls).toBe(0);
});
