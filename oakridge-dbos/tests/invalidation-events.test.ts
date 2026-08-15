import { expect, test } from "bun:test";
import { createInvalidationEventApp } from "../src/http/invalidation-events";

test("operator event stream flushes immediately before waiting for changes", async () => {
  const app = createInvalidationEventApp({ current_cursor: async () => "cursor-1", poll_interval_ms: 60_000 });
  const response = await app.request("/events");
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const reader = response.body?.getReader();
  const first = await reader?.read();
  await reader?.cancel();
  expect(new TextDecoder().decode(first?.value)).toContain(": ready");
});
