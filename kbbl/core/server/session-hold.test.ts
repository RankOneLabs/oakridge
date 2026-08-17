/**
 * Closing an agent session mid-stage abandons its unit: Oakridge's execution
 * workflow stops waiting, a gated artifact is never released, and the
 * operator's later approval lands on a workflow that already returned. kbbl
 * asks before honouring a close.
 */
import { expect, test } from "bun:test";

import { findSessionHold, sessionHoldRefusal, type SessionHold } from "./session-hold";

const hold: SessionHold = {
  session_id: "session-1", execution_id: "stage-1:0", execution_workflow_id: "root:stage:plan_writer:unit:0",
  run_id: "run-1", stage_instance_id: "stage-1", stage_key: "plan_writer", unit_id: "0",
};

const respondWith = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;

test("a session a live execution still needs is reported as held", async () => {
  expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: respondWith({ held: true, hold }) })).toEqual(hold);
});

test("a session nothing depends on is free to close", async () => {
  expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: respondWith({ held: false, hold: null }) })).toBeNull();
});

test("the lookup asks about the session it was given, escaped", async () => {
  let requested = "";
  const fetch = (async (input: string | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ held: false, hold: null }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  await findSessionHold("a/b c", { baseUrl: "http://oakridge/", fetch });
  expect(requested).toBe("http://oakridge/session_holds/a%2Fb%20c");
});

/**
 * The guard catches an ordinary operator mistake; it must not hand Oakridge a
 * veto over kbbl's own lifecycle. A close that slips through while Oakridge is
 * down is recoverable — a kbbl that cannot close sessions because a backend is
 * unhealthy is not.
 */
test("an unreachable, erroring, or unconfigured backend never blocks a close", async () => {
  const throwing = (async () => { throw new Error("connection refused"); }) as unknown as typeof globalThis.fetch;
  expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: throwing })).toBeNull();
  expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: respondWith({ error: "boom" }, 500) })).toBeNull();
  expect(await findSessionHold("session-1", { baseUrl: undefined })).toBeNull();
});

test("a malformed hold is treated as no hold rather than trusted", async () => {
  for (const body of [{ held: true, hold: { session_id: "session-1" } }, { held: true, hold: "yes" }, { held: true }, "not json at all"]) {
    expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: respondWith(body) })).toBeNull();
  }
});

test("the refusal names the work the close would have stranded", () => {
  const refusal = sessionHoldRefusal(hold);
  expect(refusal.code).toBe("session_held_by_execution");
  expect(refusal.error).toContain("plan_writer");
  expect(refusal.error).toContain("run-1");
  expect(refusal.hold).toEqual(hold);
});
