import { expect, test } from "vitest";
import { selectEventNotification } from "./run-notifications";
import { operatorEvent } from "./__fixtures__/operator-event";

test("a scope waiting on the operator becomes a notification linking that scope", () => {
  expect(selectEventNotification(operatorEvent())).toEqual({
    kind: "info", message: "spec_analysis: Awaiting work or review", href: "#oakridge/run/run-one/scope/scope-one" });
});

test("a finished scope reports success", () => {
  expect(selectEventNotification(operatorEvent({ decision: "apply", attention: null, is_terminal: true }))?.kind).toBe("success");
});

test("an intermediate transition is not operator-facing", () => {
  expect(selectEventNotification(operatorEvent({ decision: "apply", attention: null }))).toBeNull();
});

test("a notification escapes run and scope ids for the hash route", () => {
  expect(selectEventNotification(operatorEvent({ run_id: "run/one" }))?.href).toBe("#oakridge/run/run%2Fone/scope/scope-one");
});
