import { expect, test } from "bun:test";
import { Hono } from "hono";
import { withDatabase } from "./effect-fixture";
import { developmentBundle, runtimeFixture, brief, repository } from "./development-runtime-fixture";
import { installEventStream } from "../src/http/events";
import type { RunEvent } from "../src/projections/run-event";

interface Frame { readonly id: string; readonly event: RunEvent }
/** Reads SSE frames until `count` run_event frames arrive, then cancels the stream. */
async function readFrames(response: Response, count: number): Promise<readonly Frame[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const frames: Frame[] = [];
  let buffer = "";
  while (frames.length < count) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const field = (name: string) => block.split("\n").find((line) => line.startsWith(`${name}: `))?.slice(name.length + 2);
      if (field("event") === "run_event") frames.push({ id: field("id")!, event: JSON.parse(field("data")!) });
    }
  }
  await reader.cancel();
  return frames;
}

test("the event stream delivers transitions committed after subscribing and resumes from a frame's id", async () => withDatabase(async ({ db }) => {
  const f = await runtimeFixture(db, await developmentBundle(), { brief, repository });
  const app = new Hono();
  installEventStream(app, { db, timing: { poll_ms: 20, heartbeat_ms: 1_000 } });
  try {
    const live = await app.request("/events");
    expect(live.headers.get("content-type")).toContain("text/event-stream");
    await Bun.sleep(50); // the subscriber starts from now
    await f.fact("begin");
    const [first] = await readFrames(live, 1);
    expect(first!.event).toMatchObject({ run_id: f.run_id, scope_id: f.root_scope_id, scope_key: "implementation", decision: "apply", is_terminal: false });
    await f.command("cancel");
    const resumed = await readFrames(await app.request("/events", { headers: { "last-event-id": first!.id } }), 1);
    expect(resumed[0]!.event).toMatchObject({ run_id: f.run_id, decision: "apply", is_terminal: true });
    expect((await app.request("/events", { headers: { "last-event-id": "not-a-cursor" } })).status).toBe(400);
  } finally { f.core.close(); }
}));
