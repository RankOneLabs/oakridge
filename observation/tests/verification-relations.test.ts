import { expect, test } from "bun:test";
import { parseGraderConfiguration, planRegistration } from "../src/grading/configuration";
import type { LogicalItemComposite, LogicalItemLineage } from "../src/grading/composite";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import type { MeasurementReadback, RelationCheckpoint } from "../verification/proof-contract";
import { compositeOriginalAnswerChecks, lineageChecks, sharedTaskMatrix, unchangedChecks } from "../verification/relations";
import { committedGraders, integration, scratchDatabase } from "./grading-fixture";

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
  stages: [{ stage: "analysis", publication: { state: "published", is_final: false, unit_ids: ["run-1/analysis"] }, coverage, answers, statuses: [], disagreements: [], questions: [],
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
  const contributions = ["analysis", "implementation"].map((stage) => ({ kind: "contribution", item: { stage } }));
  expect(failed(lineageChecks(lineage([...definitions, ...contributions])))).toEqual([]);
  expect(failed(lineageChecks(lineage(contributions)))).toHaveLength(1);
  expect(failed(lineageChecks(lineage(definitions)))).toHaveLength(1);
});

integration("the shared-task matrix passes through real delivery, and sends no request", async () => scratchDatabase(async (db) => {
  const parsed = parseGraderConfiguration(await committedGraders());
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeProfile.questions);
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
