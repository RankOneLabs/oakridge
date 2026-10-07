import { expect, test } from "bun:test";
import type { Invocation } from "../src/core-client/generated-contracts";
import { requiresCleanup, type EffectPayload } from "../src/effects/intents";
import { exhaustStart, resolveStart, startAttemptsExhausted } from "../src/effects/outcomes";
import { selectedInvocation, type InvocationId } from "../src/effects/provider";

const selection = { definition: { operation: "run", contract_version: 1, deadline_ms: 1000, input_schema: "input",
  max_attempts: 2, outputs: [], settings: [], tools: [] }, input: { schema: "input", data: { kind: "string", value: "pinned" } },
  selection: { worker: "agent", action: "build" } } satisfies Invocation;
const payload: EffectPayload = { action: "start", handle: null,
  invocation: selectedInvocation("invocation" as InvocationId, "execution", selection) };

test("a transient failure retries below the pinned attempt limit", () => {
  expect(resolveStart({ ...payload, start_attempts: 1 }, { kind: "transiently_unavailable", detail: "busy" }).kind).toBe("retry");
});
test("a transient failure rejects at the pinned attempt limit", () => {
  expect(resolveStart({ ...payload, start_attempts: 2 }, { kind: "transiently_unavailable", detail: "busy" })).toMatchObject({
    kind: "rejected", payload: { start_attempts: 2, failure: { kind: "start_attempts_exhausted", detail: "busy" } },
  });
});
test("a permanent start rejection retains its code separately from diagnostic text", () => {
  expect(resolveStart(payload, { kind: "permanently_rejected", code: "auth", detail: "denied" }))
    .toMatchObject({ kind: "rejected", payload: { failure: { kind: "provider_rejection", code: "auth", detail: "denied" } } });
});
test("exhausting uncertain starts retains the cleanup obligation", () => {
  const outcome = resolveStart({ ...payload, start_attempts: 2 }, { kind: "uncertain", detail: "lost reply" });
  expect(outcome.kind === "rejected" && requiresCleanup({ status: "rejected", payload: outcome.payload })).toBe(true);
});
test("a successful final attempt is acknowledged", () => {
  expect(resolveStart({ ...payload, start_attempts: 2 }, { kind: "acknowledged", value: { kind: "kbbl_session", session_id: "session" } }).kind).toBe("acknowledged");
});
test("a restored persisted payload retains its exhausted budget", () => {
  expect(startAttemptsExhausted(JSON.parse(JSON.stringify({ ...payload, start_attempts: 2 })))).toBe(true);
});

test("a later definite failure cannot erase an earlier uncertain start at exhaustion", () => {
  const outcome = resolveStart({ ...payload, start_attempts: 2, has_uncertain_start: true },
    { kind: "transiently_unavailable", detail: "busy" });
  expect(outcome.kind === "rejected" && requiresCleanup({ status: "rejected", payload: outcome.payload })).toBe(true);
});
test("malformed acknowledgements exhaust the budget and require cleanup", () => {
  const outcome = resolveStart({ ...payload, start_attempts: 2 }, { kind: "acknowledged", value: {} });
  expect(outcome.kind === "rejected" && requiresCleanup({ status: "rejected", payload: outcome.payload })).toBe(true);
});
test("a one-attempt configuration rejects its first definite failure without cleanup", () => {
  const one_attempt = { ...payload, start_attempts: 1, invocation: { ...payload.invocation, selection: {
    ...selection, definition: { ...selection.definition, max_attempts: 1 },
  } } };
  const outcome = resolveStart(one_attempt, { kind: "transiently_unavailable", detail: "busy" });
  expect({ kind: outcome.kind, cleanup: requiresCleanup({ status: "rejected", payload: outcome.payload }) })
    .toEqual({ kind: "rejected", cleanup: false });
});

test("an exhausted unfinished reservation preserves cleanup when converted to rejection", () => {
  const outcome = exhaustStart({ ...payload, start_attempts: 2, start_in_flight: true });
  expect({ cleanup: requiresCleanup({ status: "rejected", payload: outcome.payload }), unfinished: outcome.payload.start_in_flight })
    .toEqual({ cleanup: true, unfinished: false });
});
test("a definite provider result settles the current reserved attempt", () => {
  expect(resolveStart({ ...payload, start_attempts: 1, start_in_flight: true },
    { kind: "transiently_unavailable", detail: "busy" }).payload.start_in_flight).toBe(false);
});
