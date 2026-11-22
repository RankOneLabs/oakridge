import { expect, test } from "bun:test";
import { ARTIFACT_KEYS, ARTIFACT_KEY_LIST } from "../src/producers/oakridge/artifact-versions";
import { selectRegistration } from "../src/producers/oakridge/catalogue";
import { oakridgeGradingRegistry, oakridgeProfile } from "../src/producers/oakridge/profile";
import { logicalItemId } from "../src/projection/relations";
import { selectRevision } from "../src/projection/extractor";
import { gradeNext } from "../src/grading/worker";
import { gradingControls } from "../src/grading/budget";
import { parseGradingDefinitions, planRegistration, stampCapture } from "../src/grading/configuration";
import { registerDefinitions } from "../src/storage/grading-store";
import { createEvidenceReconciler } from "../src/storage/evidence-pipeline";
import { listRunComposites, readLogicalItemLineage } from "../src/storage/grading-record-store";
import { withTenant } from "../src/storage/database";
import { listRunItems } from "../src/storage/projection-store";
import type { JsonValue } from "../src/domain/primitives";
import { createFeed, integration, pinIdentity, runConfig, scratchDatabase, tenant } from "./grading-fixture";

import { assessment, studyBodies, subject } from "./study-fixture";

const study = ARTIFACT_KEYS.study;
test("task kind is part of study logical identity", () => {
  const identity = { ...tenant, run_id: "study", scope: "task", producer_local_id: "A1" };
  expect(logicalItemId({ ...identity, task_kind: "case" })).not.toBe(logicalItemId({ ...identity, task_kind: "criterion" }));
});

const declarations = ARTIFACT_KEY_LIST.filter((key) => key.workflow === "study");
test("every launchable study declaration has a body accepted by its registered extractor", () => {
  for (const key of declarations) {
    const body = studyBodies[`${key.stage}.${key.artifact}`] ?? studyBodies[key.artifact];
    if (!body) throw new Error(`Missing study fixture for ${key.stage}.${key.artifact}`);
    const registration = selectRegistration({ definition_id: key.definition_id!, stage: key.stage,
      artifact_kind: key.artifact, artifact_schema_version: key.schema_version });
    expect(registration).toBeDefined();
    expect(selectRevision(body, key.artifact, registration!.extractors).issues).toEqual([]);
  }
});

integration("study captures, stub grades and later revisions separate case and criterion with the same authored id", async () => scratchDatabase(async (db) => {
  const definition = [{ id: "study.assessment", scope: "per_task", task_source: "resolved_assesses",
    targets: [{ artifact: "slice_assessment", selector: "/item_assessments/*" }], evidence: ["subject"],
    question: { text: "Was this subject assessed?", response: "choice", values: ["yes", "no"], missing_evidence_policy: "abstain",
      abstain_semantics: "Missing evidence", unclear_semantics: "Unclear", interpretation_caveats: "" },
    evaluators: [{ runner: "jev_direct", model: "fixture", estimated_cost_per_call: 0.01,
      instructions: { system_one: { type: "choice", instructions: "Check the subject.", criteria: { yes: "Yes", no: "No" } } } }],
  }];
  const parsed = parseGradingDefinitions(definition, oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(parsed.error.detail);
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(registration.error.detail);
  expect((await registerDefinitions(db, tenant, registration.value)).ok).toBe(true);
  const feed = createFeed(db, tenant, stampCapture(registration.value.capture, pinIdentity));
  const run_id = "study";
  await feed.launch({ slice_case_limit: 2, slice_cap_cents: 50, approved_plan: null }, run_id, runConfig(true));
  const publish = (key: (typeof declarations)[number], revision_id: string, body: JsonValue, predecessor_id?: string) =>
    feed.revision({ run_id, artifact_kind: key.artifact, stage: key.stage, schema_version: key.schema_version,
      definition_id: key.definition_id, revision_id, body, predecessor_id });
  for (const key of declarations) await publish(key, `${key.stage}:${key.artifact}:1`,
    studyBodies[`${key.stage}.${key.artifact}`] ?? studyBodies[key.artifact]!);
  const items = await listRunItems(db, tenant, run_id, { limit: 200, offset: 0 });
  expect(items.issues).toMatchObject({ total: 0, items: [] });
  const controls = gradingControls({});
  if (!controls.ok) throw new Error(controls.error.detail);
  const reconciler = createEvidenceReconciler({ db, collector: registration.value.collector,
    repository: { hasCommit: async () => false, readFile: async () => ({ state: "absent" }) },
    admission: { retry_limit: controls.value.retry_limit }, log: () => {} });
  const disabled = "study-off";
  await feed.launch({ slice_case_limit: 2, slice_cap_cents: 50, approved_plan: null }, disabled, runConfig(false));
  for (const [key, body] of [[study.design.plan, studyBodies.plan!], [study.design.slice_assessment, studyBodies.slice_assessment!]] as const)
    await feed.revision({ run_id: disabled, artifact_kind: key.artifact, stage: key.stage, schema_version: key.schema_version,
      definition_id: key.definition_id, revision_id: `off:${key.artifact}`, body });
  await reconciler.reconcileRun(tenant, disabled);
  await reconciler.reconcileRun(tenant, run_id);
  const admitted = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evaluation_execution").select("run_id").execute());
  expect(admitted.map((item) => item.run_id)).toEqual([run_id, run_id, run_id]);
  const worker: Parameters<typeof gradeNext>[0] = { db, tenants: [tenant], controls: controls.value, lease_owner: "study-stub", log: () => {},
    runners: () => ({ kind: "model", run: async (_input, onRequest) => {
      await onRequest?.();
      return { ok: true as const, value: { answer: { state: "answered" as const, kind: "choice" as const, value: "yes" } } };
    } }) };
  for (let index = 0; index < 3; index++) expect((await gradeNext(worker, tenant)).kind).toBe("settled");
  const profile = oakridgeProfile(registration.value.questions);
  const read = () => listRunComposites(db, tenant, profile.composite, run_id, { limit: 200, offset: 0 });
  const duplicates = (await read()).items.filter((item) => item.producer_local_id === "A1");
  expect(duplicates.map((item) => item.task_kind)).toEqual(["case", "criterion"]);
  for (const root of duplicates) expect(root.stages.flatMap((stage) => stage.results)
    .some((result) => result.status.state === "answered" && result.scope.kind === "per_task" && result.scope.task_id === root.logical_item_id)).toBe(true);
  await publish(study.design.slice_assessment, "design:slice_assessment:2",
    { ...assessment("slice-head", [subject("case", "A1")]), run_key: "slice-paid" },
    "design:slice_assessment:1");
  expect((await read()).items.filter((item) => item.producer_local_id === "A1").map((item) => item.logical_item_id))
    .toEqual(duplicates.map((item) => item.logical_item_id));
  for (const root of duplicates) {
    const lineage = await readLogicalItemLineage(db, tenant, profile.composite, run_id, root.logical_item_id, { limit: 200, offset: 0 });
    expect(lineage.items.some((entry) => entry.kind === "contribution" && entry.item.revision_id === "design:slice_assessment:2"))
      .toBe(root.task_kind === "case");
  }
}));
