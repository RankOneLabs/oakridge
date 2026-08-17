/**
 * Closing an agent session mid-stage abandons its unit: Oakridge's execution
 * workflow stops waiting, a gated artifact is never released, and the
 * operator's later approval lands on a workflow that already returned. kbbl
 * asks before honouring a close.
 */
import { expect, test } from "bun:test";

import {
  findSessionHold, isTruthyFlag, selectCloseAuthority, selectCloseRefusal, sessionHoldRefusal, type SessionHold,
} from "./session-hold";

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

/**
 * The guard's whole purpose is to refuse closes arriving from outside the
 * execution that owns the session. Oakridge fencing its own unit is the
 * opposite case, and it arrives through the same endpoint — so treating it
 * like an operator deadlocks the run against itself: uncancellable because it
 * is still active, still active because its session will not close.
 */
test("an execution fencing the session it holds is not refused", () => {
  expect(selectCloseRefusal({ kind: "execution_fence", execution_id: hold.execution_id }, hold)).toBeNull();
});

test("an execution may not fence a session some other execution holds", () => {
  const refusal = selectCloseRefusal({ kind: "execution_fence", execution_id: "stage-9:3" }, hold);
  expect(refusal?.code).toBe("session_held_by_execution");
});

test("an operator close is refused while a unit still depends on the session", () => {
  expect(selectCloseRefusal({ kind: "operator" }, hold)?.code).toBe("session_held_by_execution");
});

test("an operator who has seen the refusal and asked again gets through", () => {
  expect(selectCloseRefusal({ kind: "operator_override" }, hold)).toBeNull();
});

test("a session nothing holds closes for anyone", () => {
  for (const authority of [{ kind: "operator" } as const, { kind: "operator_override" } as const, { kind: "execution_fence", execution_id: "x" } as const]) {
    expect(selectCloseRefusal(authority, null)).toBeNull();
  }
});

test("an explicit override outranks a fence marker on the same request", () => {
  expect(selectCloseAuthority({ force: "1", fenced_by: "stage-9:3" })).toEqual({ kind: "operator_override" });
});

test("a request carrying neither marker is an ordinary operator close", () => {
  expect(selectCloseAuthority({ force: undefined, fenced_by: undefined })).toEqual({ kind: "operator" });
  expect(selectCloseAuthority({ force: "false", fenced_by: "" })).toEqual({ kind: "operator" });
});

test("a fence marker names the execution doing the fencing", () => {
  expect(selectCloseAuthority({ force: undefined, fenced_by: "stage-1:0" })).toEqual({ kind: "execution_fence", execution_id: "stage-1:0" });
});

test("a flag spelled falsely is not read as set", () => {
  for (const raw of ["0", "false", "FALSE", "no", "off", "", undefined]) expect(isTruthyFlag(raw)).toBe(false);
  for (const raw of ["1", "true", "yes", "on", "anything"]) expect(isTruthyFlag(raw)).toBe(true);
});
