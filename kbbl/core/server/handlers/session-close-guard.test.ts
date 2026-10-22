/**
 * The close guard, exercised through the real route.
 *
 * `session-hold.test.ts` covers the decision in isolation; this covers the
 * wiring. Oakridge stops its own attempts by closing their sessions through
 * this route, naming the attempt's action (`fenced_by` for a fresh session,
 * `closed_by` for a resumed one), so the guard must let the holder through
 * while still refusing anyone else. `oakridge-dbos/tests/kbbl-adapter.test.ts`
 * pins the other end of that contract.
 */
import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountSessionsRoutes } from "./sessions";
import type { AcpSessionService } from "../../acp/session-service";
import { ok, type FenceContext } from "../../acp/types";

const SID = "db26174d-21e2-40f4-af40-fc359c4e9604";
const HOLDER = "3f1c0b9a7e2d4c5b";

const hold = { session_id: SID, run_id: "run-9e868912", unit_id: "run-9e868912/analysis", worker: "analyst", action_id: HOLDER };

interface Closed {
  readonly aborted: string[];
  readonly fences: Array<FenceContext | undefined>;
}

/**
 * The stub Oakridge must outlive each request, since the route awaits the hold
 * lookup — but not the test that started it. Stopping them here keeps the
 * suite from accumulating listeners it never closes.
 */
const stubs: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const stub of stubs) stub.stop(true);
  stubs.length = 0;
});

/**
 * A kbbl whose Oakridge reports the session as held by `HOLDER`, with a
 * session that records whether it was actually closed.
 */
const guardedApp = (): { app: Hono; closed: Closed } => {
  const closed: Closed = { aborted: [], fences: [] };
  const acp = {
    getSession: (sid: string) => ({ sid, status: "idle" }),
    closeSession: async (sid: string, fence?: FenceContext) => {
      closed.aborted.push(sid);
      closed.fences.push(fence);
      return ok(undefined);
    },
  } as unknown as AcpSessionService;

  const oakridge = new Hono();
  oakridge.get("/session_holds/:sid", (c) =>
    c.req.param("sid") === SID ? c.json({ hold }) : c.json({ hold: null }));
  const oakridgeServer = Bun.serve({ port: 0, fetch: oakridge.fetch });
  stubs.push(oakridgeServer);

  const app = new Hono();
  mountSessionsRoutes(app, {
    acp,
    defaultWorkdir: "/tmp/kbbl-test",
    oakridgeBaseUrl: `http://127.0.0.1:${oakridgeServer.port}`,
  });
  return { app, closed };
};

test("an operator close is refused while a running attempt still uses the session", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(new Request(`http://kbbl/sessions/${SID}`, { method: "DELETE" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "session_held_by_attempt" });
  expect(closed.aborted).toEqual([]);
});

/** Oakridge stopping a fresh session's attempt reaches the agent through this route; a refusal would leave the run unstoppable. */
test("the attempt holding the session may fence it, and the session actually closes", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(
    new Request(`http://kbbl/sessions/${SID}?fenced_by=${encodeURIComponent(HOLDER)}`, { method: "DELETE" }));
  expect(response.status).toBe(200);
  expect(closed.aborted).toEqual([SID]);
  // The fencer's identity travels into the fence sequence (§10.5), not a
  // plain close.
  expect(closed.fences).toEqual([{ fenced_by: HOLDER }]);
});

test("one attempt may not fence the session another attempt holds", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(
    new Request(`http://kbbl/sessions/${SID}?fenced_by=some-other-action`, { method: "DELETE" }));
  expect(response.status).toBe(409);
  expect(closed.aborted).toEqual([]);
});

test("an operator who has seen the refusal can still force the close", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(new Request(`http://kbbl/sessions/${SID}?force=1`, { method: "DELETE" }));
  expect(response.status).toBe(200);
  expect(closed.aborted).toEqual([SID]);
});

test("the attempt holding a resumed session may close it without fencing it", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(
    new Request(`http://kbbl/sessions/${SID}?closed_by=${encodeURIComponent(HOLDER)}`, { method: "DELETE" }));
  expect(response.status).toBe(200);
  expect(closed.aborted).toEqual([SID]);
  expect(closed.fences).toEqual([undefined]);
});

test("a session no attempt holds closes without a marker", async () => {
  const { app, closed } = guardedApp();
  const free = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const response = await app.fetch(new Request(`http://kbbl/sessions/${free}`, { method: "DELETE" }));
  expect(response.status).toBe(200);
  expect(closed.aborted).toEqual([free]);
});
