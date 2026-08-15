import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export interface InvalidationEventDependencies {
  readonly current_cursor: () => Promise<string>;
  readonly poll_interval_ms?: number;
}

export const createInvalidationEventApp = (dependencies: InvalidationEventDependencies): Hono => {
  const app = new Hono();
  app.get("/events", (http) => streamSSE(http, async (stream) => {
    let cursor = await dependencies.current_cursor();
    await stream.write(": ready\n\n");
    while (!stream.aborted) {
      await stream.sleep(dependencies.poll_interval_ms ?? 1_000);
      const next = await dependencies.current_cursor();
      if (next === cursor) continue;
      cursor = next;
      await stream.writeSSE({ event: "invalidate", data: JSON.stringify({ kind: "invalidate" }), id: cursor });
    }
  }));
  return app;
};
