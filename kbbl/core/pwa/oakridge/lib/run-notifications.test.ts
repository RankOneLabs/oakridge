import { expect, test } from "vitest";
import { selectRunFrameNotification, selectRunNotification } from "./run-notifications";
import { operatorTransition, runEventFrame } from "./__fixtures__/run-event-frame";

test("a transition handing the unit to the operator becomes an actionable notification", () => {
  expect(selectRunNotification(runEventFrame({ effect: operatorTransition }))).toEqual({
    kind: "info", message: "Review needs operator action (awaiting_operator)", href: "#oakridge/run/run-one" });
});

test("a notification links the run it came from, escaped for the hash route", () => {
  expect(selectRunNotification(runEventFrame({ run_id: "run/one", effect: operatorTransition }))?.href)
    .toBe("#oakridge/run/run%2Fone");
});

test("a transition handing the unit to a worker is not operator-facing", () => {
  expect(selectRunNotification(runEventFrame({ effect: { ...operatorTransition, next_actor: "worker" } }))).toBeNull();
});

test("a confirmed pull request merge reports success", () => {
  expect(selectRunNotification(runEventFrame({ effect: { kind: "pull_request_merge_confirmed", repository_key: "oakridge",
    pull_request_url: "https://example.test/pr/1", state: "merged", source: "poll", merged_at: "2026-01-01T00:00:00Z" } }))?.kind)
    .toBe("success");
});

test("a retry decision reports the relaunch", () => {
  expect(selectRunNotification(runEventFrame({ effect: { kind: "worker_decision", cohort_id: "cohort-1",
    from_state: "working", to_state: "working", actions: [{ worker: "builder", action_point: "retry" }] } }))?.message)
    .toBe("Retry launched");
});

test("a worker decision without a retry action is not operator-facing", () => {
  expect(selectRunNotification(runEventFrame({ effect: { kind: "worker_decision", cohort_id: "cohort-1",
    from_state: "working", to_state: "working", actions: [{ worker: "builder", action_point: "start" }] } }))).toBeNull();
});

test("an effect the operator surface does not present is not a notification", () => {
  expect(selectRunNotification(runEventFrame({ effect: { kind: "unrecognized", effect_kind: "future_effect" } }))).toBeNull();
});

test("a live frame notifies", () => {
  expect(selectRunFrameNotification(runEventFrame({ effect: operatorTransition, replayed: false }))).not.toBeNull();
});

test("a replayed frame does not re-notify for a transition already seen", () => {
  expect(selectRunFrameNotification(runEventFrame({ effect: operatorTransition, replayed: true }))).toBeNull();
});
