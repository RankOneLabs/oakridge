import { expect, test } from "vitest";
import { selectEventNotification } from "./run-notifications";
import { makeRunEvent } from "../__fixtures__/read-models";

test("a unit waiting on the operator becomes a notification linking that unit", () => {
  expect(selectEventNotification(makeRunEvent())).toEqual({
    kind: "info", message: "analysis: Analysis: awaiting analysis_review review", href: "#oakridge/run/run-one/unit/unit-one" });
});

test("a finished unit reports success", () => {
  expect(selectEventNotification(makeRunEvent({ awaiting: null, is_terminal: true }))?.kind).toBe("success");
});

test("an intermediate event is not operator-facing", () => {
  expect(selectEventNotification(makeRunEvent({ awaiting: null }))).toBeNull();
});

test("a notification escapes run and unit ids for the hash route", () => {
  expect(selectEventNotification(makeRunEvent({ run_id: "run/one" }))?.href).toBe("#oakridge/run/run%2Fone/unit/unit-one");
});
