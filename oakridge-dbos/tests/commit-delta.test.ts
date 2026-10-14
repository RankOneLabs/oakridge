import { expect, test } from "bun:test";
import type { StepSnapshot } from "../src/core-client/core-types";
import { scopeIngressId, selectCommitPlan, selectDeltaViolation } from "../src/storage/commit";
import type { IngressId, RunId } from "../src/domain/primitives";

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
    run_id: selectDeltaViolation(snapshot([unit]), { ...snapshot([unit]), run: { ...snapshot([unit]).run, id: "other" } }),
  }).toEqual({
    input: "unit run/document changed an input it had already resolved",
    after: "unit run/document changed its declaration, parent, stage, pool or dependencies",
    removed: "unit run/document was removed",
    run_id: "run run changed its id to other",
  });
});

test("each writer's ingress ids live in their own namespace", () => {
  expect([
    scopeIngressId({ kind: "operator", subject: "credential:a" }, "r1"),
    scopeIngressId({ kind: "executor", attempt: "a" }, "r1"),
    scopeIngressId({ kind: "session", session: "s1", attempt: "a" }, "r1"),
    scopeIngressId({ kind: "engine" }, null),
  ]).toEqual(["operator:r1" as IngressId, "executor:r1" as IngressId, "session:s1:r1" as IngressId, null]);
});

test("the pure plan rejects a publication secret on an event that cannot carry one", () => {
  const before = snapshot([unit]);
  const plan = selectCommitPlan(before, { snapshot: before, wanted: [], reviews: [] }, {
    request: { run_id: "run" as RunId, ingress_id: null, event: { kind: "cancel_requested" }, writer: { kind: "engine" },
      publication_secret_hash: "hash" },
    digest: "digest", unit_id: null, source: { workflow: "test", input: "text", run: { units: {}, outcome: {} }, stages: {} },
    prompts: {}, config: null, intent_actions: [], review_rows: [], prompt_texts: new Map(), logged_wanted: new Map(),
    event_id: "event-1", occurred_at: new Date(0),
  });
  expect(plan).toEqual({ ok: false, error: { operation: "select_commit_plan", entity_id: "run",
    detail: "a publication secret hash rides only on worker_started, not cancel_requested" } });
});
