/**
 * Closing an agent session while an Oakridge attempt still uses it strands
 * that attempt: its worker can no longer publish, and the run waits on work
 * the agent may already have done. kbbl asks before honouring a close.
 */
import { expect, test } from "bun:test";

import type { SessionHold } from "../session/session-hold";
import {
  findSessionHold, isTruthyFlag, selectCloseAuthority, selectCloseRefusal, sessionHoldRefusal,
} from "./session-hold";

const hold: SessionHold = { session_id: "session-1", run_id: "run-1", unit_id: "run-1/planning", worker: "planner", action_id: "action-1" };

const respondWith = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof globalThis.fetch;

test("a session a running attempt still uses is reported as held", async () => {
  expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: respondWith({ hold }) })).toEqual(hold);
});

test("a session nothing depends on is free to close", async () => {
  expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: respondWith({ hold: null }) })).toBeNull();
});

test("the lookup asks about the session it was given, escaped", async () => {
  let requested = "";
  const fetch = (async (input: string | URL) => {
    requested = String(input);
    return new Response(JSON.stringify({ hold: null }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  await findSessionHold("a/b c", { baseUrl: "http://oakridge/", fetch });
  expect(requested).toBe("http://oakridge/session_holds/a%2Fb%20c");
});

test("the lookup carries the control token the backend's operator routes require", async () => {
  let authorization = null as string | null;
  const fetch = (async (_input: string | URL, init?: RequestInit) => {
    authorization = new Headers(init?.headers).get("authorization");
    return new Response(JSON.stringify({ hold }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", controlToken: "secret", fetch })).toEqual(hold);
  expect(authorization).toBe("Bearer secret");
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
  for (const body of [{ hold: { session_id: "session-1" } }, { hold: "yes" }, {}, "not json at all"]) {
    expect(await findSessionHold("session-1", { baseUrl: "http://oakridge", fetch: respondWith(body) })).toBeNull();
  }
});

test("the refusal names the attempt the close would have stranded", () => {
  const refusal = sessionHoldRefusal(hold);
  expect(refusal.code).toBe("session_held_by_attempt");
  expect(refusal.error).toContain("planner");
  expect(refusal.error).toContain("run-1");
  expect(refusal.hold).toEqual(hold);
});

/**
 * Oakridge stopping its own attempt arrives through the same endpoint as an
 * operator's close; treating it like one would leave the run unable to stop
 * the attempt, and the attempt unable to end while its session stays open.
 */
test("the attempt holding the session may close it", () => {
  expect(selectCloseRefusal({ kind: "attempt", action_id: hold.action_id }, hold)).toBeNull();
});

test("an attempt may not close a session another attempt holds", () => {
  expect(selectCloseRefusal({ kind: "attempt", action_id: "action-9" }, hold)?.code).toBe("session_held_by_attempt");
});

test("an operator close is refused while an attempt still uses the session", () => {
  expect(selectCloseRefusal({ kind: "operator" }, hold)?.code).toBe("session_held_by_attempt");
});

test("an operator who has seen the refusal and asked again gets through", () => {
  expect(selectCloseRefusal({ kind: "operator_override" }, hold)).toBeNull();
});

test("a session nothing holds closes for anyone", () => {
  for (const authority of [{ kind: "operator" } as const, { kind: "operator_override" } as const, { kind: "attempt", action_id: "x" } as const]) {
    expect(selectCloseRefusal(authority, null)).toBeNull();
  }
});

test("an explicit override outranks an attempt's marker on the same request", () => {
  expect(selectCloseAuthority({ force: "1", fenced_by: "action-9", closed_by: undefined })).toEqual({ kind: "operator_override" });
});

test("a request carrying no marker is an ordinary operator close", () => {
  expect(selectCloseAuthority({ force: undefined, fenced_by: undefined, closed_by: undefined })).toEqual({ kind: "operator" });
  expect(selectCloseAuthority({ force: "false", fenced_by: "", closed_by: "" })).toEqual({ kind: "operator" });
});

test("a fence or a close marker names the attempt's action", () => {
  expect([selectCloseAuthority({ force: undefined, fenced_by: "action-1", closed_by: undefined }),
    selectCloseAuthority({ force: undefined, fenced_by: undefined, closed_by: "action-2" })])
    .toEqual([{ kind: "attempt", action_id: "action-1" }, { kind: "attempt", action_id: "action-2" }]);
});

test("a flag spelled falsely is not read as set", () => {
  for (const raw of ["0", "false", "FALSE", "no", "off", "", undefined]) expect(isTruthyFlag(raw)).toBe(false);
  for (const raw of ["1", "true", "yes", "on", "anything"]) expect(isTruthyFlag(raw)).toBe(true);
});
