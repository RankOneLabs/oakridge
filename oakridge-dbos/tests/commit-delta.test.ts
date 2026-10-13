import { expect, test } from "bun:test";
import type { StepSnapshot } from "../src/core-client/core-types";
import { scopeIngressId, selectDeltaViolation } from "../src/storage/commit";

type Unit = StepSnapshot["units"][number];
const unit: Unit = { id: "run/document", parent: "run", declaration: "document", stage: "document", pool: null, input: null,
  status: { kind: "blocked", reason: { kind: "waiting_on", units: ["run/first"] } }, after: ["run/first"] };
const snapshot = (units: StepSnapshot["units"]): StepSnapshot => ({ run: { id: "run", root: "run", input: null, status: { kind: "active" } },
  units, attempts: [], revisions: [], decisions: [], retry_events: [] });

test("a unit resolving its input as it starts is a delta commit writes", () => {
  expect(selectDeltaViolation(snapshot([unit]), snapshot([{ ...unit, input: { topic: "Oakridge" }, status: { kind: "active" } }]))).toBeNull();
});

test("a change commit would not write is named instead of being dropped", () => {
  const resolved = { ...unit, input: { topic: "Oakridge" } };
  expect({
    input: selectDeltaViolation(snapshot([resolved]), snapshot([{ ...resolved, input: { topic: "other" } }])),
    after: selectDeltaViolation(snapshot([unit]), snapshot([{ ...unit, after: [] }])),
    removed: selectDeltaViolation(snapshot([unit]), snapshot([])),
  }).toEqual({
    input: "unit run/document changed an input it had already resolved",
    after: "unit run/document changed its declaration, parent, stage, pool or dependencies",
    removed: "unit run/document was removed",
  });
});

test("each writer's ingress ids live in their own namespace", () => {
  expect([
    scopeIngressId({ kind: "operator", subject: "credential:a" }, "r1"),
    scopeIngressId({ kind: "executor", attempt: "a" }, "r1"),
    scopeIngressId({ kind: "session", session: "s1", attempt: "a" }, "r1"),
    scopeIngressId({ kind: "engine" }, null),
  ]).toEqual(["operator:r1", "executor:r1", "session:s1:r1", null]);
});
