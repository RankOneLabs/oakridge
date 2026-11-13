import { expect, test } from "bun:test";
import { parseGradingDefinitions, planRegistration } from "../src/grading/configuration";
import type { LogicalItemComposite, LogicalItemLineage } from "../src/grading/composite";
import { oakridgeGradingRegistry, fixtureDefinitions, integration, scratchDatabase } from "./grading-fixture";
import type { MeasurementReadback, RelationCheckpoint } from "../verification/proof-contract";
import { compositeOriginalAnswerChecks, lineageChecks, sharedRunChecks, sharedTaskMatrix, totalRequests, unchangedChecks, UNRESOLVED_TASK, withoutLinks, type SharedRunReads } from "../verification/relations";

const facts = (occurrence_id: string, grades: unknown = { items: ["g1"] }) => ({ occurrence_id, occurrence: { occurrence_id }, evidence: { items: ["e1"] }, grades, measurements: { questions: [] } });
const checkpoint = (name: string, overrides: Partial<RelationCheckpoint> = {}): RelationCheckpoint => ({ checkpoint: name, run_id: "run-1", linked: facts("linked"), control: facts("control"),
  requests_sent: 3, attempts: 3, executions: { completed: 3 }, authority_events: 10, ...overrides });
const failed = (checks: readonly { readonly name: string; readonly passed: boolean }[]) => checks.filter((check) => !check.passed).map((check) => check.name);

test("a link that moved nothing passes, and each kind of movement is caught by name", () => {
  expect(failed(unchangedChecks(checkpoint("a"), checkpoint("b"), "the link"))).toEqual([]);
  expect(failed(unchangedChecks(checkpoint("a"), checkpoint("b", { linked: facts("linked", { items: ["g1", "regraded"] }) }), "the link")))
    .toEqual(["the link: the linked item's identity, pins, frozen evidence, measurements and answers are unchanged"]);
  expect(failed(unchangedChecks(checkpoint("a"), checkpoint("b", { control: facts("control", { items: [] }) }), "the link"))).toEqual(["the link: the unlinked control is unchanged"]);
  expect(failed(unchangedChecks(checkpoint("a"), checkpoint("b", { requests_sent: 4 }), "the link"))).toEqual(["the link: no execution, provider attempt or request was added"]);
  expect(failed(unchangedChecks(checkpoint("a"), checkpoint("b", { executions: { completed: 3, queued: 1 } }), "the link"))).toEqual(["the link: no execution, provider attempt or request was added"]);
});

const composite = (coverage: "linked" | "gap", answers: readonly unknown[]): LogicalItemComposite => ({ run_id: "run-1", logical_item_id: "t", scope: "task", producer_local_id: "T1", coverage,
  stages: [{ stage: "analysis", publication: { state: "published", is_final: false, unit_ids: ["run-1/analysis"] }, state: coverage, results: answers.map((answer) => ({ status: { state: "answered", answer } })), answers, statuses: [], disagreements: [], questions: [],
    totals: {} as never, items: {} as never, history: {} as never }] } as never as LogicalItemComposite);
const answered = (observation_id: string) => ({ observation_id }) as MeasurementReadback;

test("the composite must open the very observations the item had before the link", () => {
  const read = composite("linked", [{ question: { question_id: "q" }, answer: { state: "answered", value: "relevant" }, count: 1 }]);
  expect(failed(compositeOriginalAnswerChecks(read, [answered("g1")], ["g1"]))).toEqual([]);
  expect(failed(compositeOriginalAnswerChecks(read, [answered("g1")], ["g2"]))).toEqual(["what its count opens is the original observation, not a new one"]);
  expect(failed(compositeOriginalAnswerChecks(composite("gap", []), [answered("g1")], ["g1"]))).toEqual(["the task's composite shows the original answer as soon as the link arrives"]);
});

test("lineage must reach its definitions and both contributing stages", () => {
  const lineage = (entries: readonly unknown[]) => ({ items: entries }) as unknown as LogicalItemLineage;
  const definitions = ["tasks", "plan", "brief"].map((artifact_kind) => ({ kind: "occurrence", artifact_kind }));
  const contributions = ["analysis", "cohort"].map((stage) => ({ kind: "contribution", item: { stage } }));
  expect(failed(lineageChecks(lineage([...definitions, ...contributions])))).toEqual([]);
  expect(failed(lineageChecks(lineage(contributions)))).toHaveLength(1);
  expect(failed(lineageChecks(lineage(definitions)))).toHaveLength(1);
});

test("the request total adds each run's latest count, whichever run checked last", () => {
  expect(totalRequests([])).toBeNull();
  expect(totalRequests([checkpoint("a", { run_id: "one", requests_sent: 5 }), checkpoint("b", { run_id: "one", requests_sent: 15 }), checkpoint("c", { run_id: "two", requests_sent: 3 })])).toBe(18);
});

const sharedReads = (overrides: Partial<SharedRunReads> = {}): SharedRunReads => {
  const stages = [
    { stage: "analysis", totals: { contributing_items: 2 }, publication: { state: "published", is_final: false, unit_ids: ["run/analysis"] } },
    { stage: "cohort", totals: { contributing_items: 2 }, publication: { state: "published", is_final: false, unit_ids: ["run/implementation/alpha", "run/implementation/beta"] } },
    { stage: "integration", totals: { contributing_items: 0 }, publication: { state: "pending" } }];
  const row = (unit_id: string, answers = 1) => ({ item: { unit_id }, questions: { items: [{ answers: { total: answers } }] } });
  const occurrence = (artifact_kind: string, unit_id: string, is_current: boolean) => ({ kind: "occurrence", artifact_kind, unit_id, is_current });
  return { shared: { producer_local_id: "T1", stages } as never, other: { producer_local_id: "T2", stages: [{ stage: "analysis", totals: { contributing_items: 1 } }] } as never,
    implementation_rows: { items: [row("run/implementation/alpha"), row("run/implementation/beta")] } as never,
    lineage: { items: [occurrence("tasks", "run/analysis", true), occurrence("plan", "run/planning", false), occurrence("plan", "run/planning", true),
      occurrence("brief", "run/briefs/alpha", false), occurrence("brief", "run/briefs/alpha", true), occurrence("brief", "run/briefs/beta", true)] } as never,
    unlinked_control: true, unresolved_visible: true, ...overrides };
};
test("a real shared run must reach both cohorts, real revisions and pending integration, and each gap is named", () => {
  expect(failed(sharedRunChecks(sharedReads()))).toEqual([]);
  const oneCohort = { items: [{ item: { unit_id: "run/implementation/alpha" }, questions: { items: [{ answers: { total: 1 } }] } }] } as never;
  expect(failed(sharedRunChecks(sharedReads({ implementation_rows: oneCohort })))).toEqual(["real: one task stands under both cohorts' implementation assessments", "real: the provider answered findings of that task in both cohorts"]);
  const unrevised = { items: [{ kind: "occurrence", artifact_kind: "tasks", unit_id: "a", is_current: true }, { kind: "occurrence", artifact_kind: "plan", unit_id: "p", is_current: true }] } as never;
  expect(failed(sharedRunChecks(sharedReads({ lineage: unrevised })))).toEqual(["real: the task is one logical item through its task list, the revised plan and both revised briefs"]);
  expect(failed(sharedRunChecks(sharedReads({ unlinked_control: false, unresolved_visible: false })))).toEqual(["real: the unlinked control stays listed", "real: the unknown task stays a visible reference"]);
  expect(UNRESOLVED_TASK).toBe("T-not-in-this-run");
});

integration("the shared-task matrix passes through real delivery, and sends no request", async () => scratchDatabase(async (db) => {
  const parsed = parseGradingDefinitions(await fixtureDefinitions(), oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  const realFetch = globalThis.fetch;
  let outbound = 0;
  globalThis.fetch = (async () => { outbound++; throw new Error("no outbound request is allowed"); }) as unknown as typeof fetch;
  try {
    const { checks } = await sharedTaskMatrix(db, { producer: "oakridge", namespace: "matrix-test" }, registration.value);
    expect(failed(checks)).toEqual([]);
    expect(checks.length).toBeGreaterThan(5);
  } finally { globalThis.fetch = realFetch; }
  expect(outbound).toBe(0);
}));

test("a link changes an item's links and none of what must not move", () => {
  const status = { item: { occurrence_id: "o" }, questions: { items: ["q"] } };
  expect(withoutLinks({ ...status, links: { items: [{ task: "T1" }], total: 1 } })).toEqual(withoutLinks({ ...status, links: { items: [], total: 0 } }));
  expect(withoutLinks({ ...status, links: { items: [] } })).toEqual(status);
});
