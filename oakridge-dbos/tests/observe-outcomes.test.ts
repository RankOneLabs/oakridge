import { expect, test } from "bun:test";
import { resolveObserve, settleObserveRetry } from "../src/effects/outcomes";
import type { StableInvocation } from "../src/effects/provider";
import { requiresCleanup } from "../src/effects/intents";

test("permanent and malformed terminal observations reject rather than retry", () => {
  const payload = { invocation: {} as StableInvocation, action: "start" as const, handle: null };
  expect(resolveObserve(payload, { kind: "permanently_rejected", code: "invalid", detail: "broken" }).kind).toBe("rejected");
  expect(resolveObserve(payload, { kind: "acknowledged", value: { kind: "terminal", result: null } }).kind).toBe("rejected");
});

test("consecutive unavailable observations reject at the configured bound and running resets the count", () => {
  const initial = { invocation: {} as StableInvocation, action: "start" as const, handle: null };
  const unavailable = { kind: "transiently_unavailable" as const, detail: "kbbl down" };
  const first = resolveObserve(initial, unavailable);
  if (first.kind !== "retry") throw new Error("first observation did not retry");
  const pending = settleObserveRetry(initial, first, 2);
  expect(pending).toMatchObject({ status: "acknowledged", payload: { observe_unavailable_attempts: 1 } });
  expect(resolveObserve(pending.payload, { kind: "acknowledged", value: { kind: "running" } }).kind).toBe("running");
  const second = resolveObserve(pending.payload, unavailable);
  if (second.kind !== "retry") throw new Error("second observation did not retry");
  expect(settleObserveRetry(pending.payload, second, 2)).toMatchObject({ status: "rejected", payload: { observe_unavailable_attempts: 2 } });
  const afterRunning = resolveObserve({ ...pending.payload, observe_unavailable_attempts: 0 }, unavailable);
  if (afterRunning.kind !== "retry") throw new Error("observation after running did not retry");
  expect(settleObserveRetry(initial, afterRunning, 2).status).toBe("acknowledged");
});

test("a rejected observation with an acknowledged handle still owes cleanup", () => {
  expect(requiresCleanup({ status: "rejected", payload: { invocation: {} as StableInvocation, action: "start",
    handle: { kind: "kbbl_session", session_id: "session" } } })).toBe(true);
});
