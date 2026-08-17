/**
 * The close guard, exercised through the real route.
 *
 * `session-hold.test.ts` covers the decision in isolation; this covers the
 * wiring, which is where the deadlock actually lived. Both halves were
 * individually correct — kbbl refused closes that would abandon a live unit,
 * and Oakridge fenced its agents by closing their sessions — but Oakridge's
 * fence arrived as an unqualified DELETE, so the guard refused the owner's own
 * teardown. The run could not be cancelled while it was active, and it stayed
 * active because its session would not close.
 *
 * The `fenced_by` query parameter is the contract between the two packages;
 * `oakridge-dbos/tests/kbbl-adapter.test.ts` pins the other end of it.
 */
import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";

import { mountSessionsRoutes } from "./sessions";
import type { SessionManager } from "../../session/session-manager";

const SID = "db26174d-21e2-40f4-af40-fc359c4e9604";
const HOLDER = "012c6027-4a21-4ec4-aadd-244ebf3236a9:0";

const hold = {
  session_id: SID,
  execution_id: HOLDER,
  execution_workflow_id: "oakridge-run:9e868912:attempt:initial:stage:spec_analyzer:unit:0",
  run_id: "9e868912-4944-4687-8316-0c2f6470bc3c",
  stage_instance_id: "012c6027-4a21-4ec4-aadd-244ebf3236a9",
  stage_key: "spec_analyzer",
  unit_id: "0",
};

interface Closed {
  readonly aborted: string[];
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
  const closed: Closed = { aborted: [] };
  const manager = {
    get: (sid: string) => ({
      markEndReason: () => {},
      abort: async () => {
        closed.aborted.push(sid);
        return 0;
      },
    }),
  } as unknown as SessionManager;

  const oakridge = new Hono();
  oakridge.get("/session_holds/:sid", (c) =>
    c.req.param("sid") === SID ? c.json({ held: true, hold }) : c.json({ held: false, hold: null }));
  const oakridgeServer = Bun.serve({ port: 0, fetch: oakridge.fetch });
  stubs.push(oakridgeServer);

  const app = new Hono();
  mountSessionsRoutes(app, {
    manager,
    defaultWorkdir: "/tmp/kbbl-test",
    sessionsDir: "/tmp/kbbl-test",
    oakridgeBaseUrl: `http://127.0.0.1:${oakridgeServer.port}`,
  });
  return { app, closed };
};

test("an operator close is refused while a live unit still depends on the session", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(new Request(`http://kbbl/sessions/${SID}`, { method: "DELETE" }));
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "session_held_by_execution" });
  expect(closed.aborted).toEqual([]);
});

/**
 * The regression. Oakridge cancelling a run reaches its agent through this
 * route; if the guard refuses, the run is uncancellable.
 */
test("the execution holding the session may fence it, and the session actually closes", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(
    new Request(`http://kbbl/sessions/${SID}?fenced_by=${encodeURIComponent(HOLDER)}`, { method: "DELETE" }));
  expect(response.status).toBe(200);
  expect(closed.aborted).toEqual([SID]);
});

test("one execution may not fence the session another execution holds", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(
    new Request(`http://kbbl/sessions/${SID}?fenced_by=some-other-stage%3A3`, { method: "DELETE" }));
  expect(response.status).toBe(409);
  expect(closed.aborted).toEqual([]);
});

test("an operator who has seen the refusal can still force the close", async () => {
  const { app, closed } = guardedApp();
  const response = await app.fetch(new Request(`http://kbbl/sessions/${SID}?force=1`, { method: "DELETE" }));
  expect(response.status).toBe(200);
  expect(closed.aborted).toEqual([SID]);
});

test("a session no execution holds closes without a marker", async () => {
  const { app, closed } = guardedApp();
  const free = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const response = await app.fetch(new Request(`http://kbbl/sessions/${free}`, { method: "DELETE" }));
  expect(response.status).toBe(200);
  expect(closed.aborted).toEqual([free]);
});
