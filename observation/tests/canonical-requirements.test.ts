import { createFeed, integration, revisionOutcome, scratchDatabase, tenant } from "./grading-fixture";
import { registerDefinitions } from "../src/storage/grading-store";
import { readItemAt, listRunComposites } from "../src/storage/grading-record-store";
import { readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import { createApp } from "../src/http/app";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JsonValue } from "../src/domain/primitives";
import type { ItemOccurrenceId, LogicalItemId } from "../src/domain/identity";
import { DEVELOPMENT_ARTIFACT_VERSIONS } from "../src/producers/oakridge/artifact-versions";
import { oakridgeCatalogue, TASK_SCOPE } from "../src/producers/oakridge/catalogue";
import { oakridgeGradingRegistry } from "../src/producers/oakridge/profile";
import { selectRevision } from "../src/projection/extractor";
import { logicalItemId, logicalItemRelation } from "../src/projection/relations";
import { gradingSubjects } from "../src/grading/evidence";
import { parseGradingDefinitions, planRegistration, stampCapture } from "../src/grading/configuration";
const fixture = (kind: string): JsonValue => JSON.parse(readFileSync(new URL(`../../kbbl/core/pwa/oakridge/__fixtures__/current-${kind}.json`, import.meta.url), "utf8"));
const versions = DEVELOPMENT_ARTIFACT_VERSIONS;
const bodies = { analysis: fixture("analysis"), spec: fixture("spec"), plan: fixture("plan"), brief: fixture("brief") };
test.each([
  ["analysis", versions.analysis_body.version, ["/requirements/0/findings/0", "/requirements/0/findings/1", "/requirements/1/findings/0", "/requirements/1/findings/1", "/requirements/2/findings/0"]],
  ["spec", versions.spec_body.version, ["/requirements/0", "/requirements/1", "/requirements/2"]],
  ["plan", versions.plan_body.version, ["/cohorts/0/allocations/0", "/cohorts/1/allocations/0", "/cohorts/2/allocations/0"]],
  ["brief", versions.brief_body.version, ["/build_items/0", "/build_items/1"]],
] as const)("current %s extracts exactly the PWA's current item paths", (kind, version, paths) => {
  const original = structuredClone(bodies[kind]);
  const pass = selectRevision(bodies[kind], kind, oakridgeCatalogue(kind, version));
  expect(pass.issues).toEqual([]);
  expect(pass.items.filter(({ item }) => kind === "analysis" ? item.item_kind === "finding"
    : kind === "brief" ? item.item_kind === "build_item" : true).map(({ item }) => item.path)).toEqual([...paths]);
  expect(bodies[kind]).toEqual(original);
});
test("spec ids define canonical roots and a split plan retains both contributions", () => {
  const spec = selectRevision(bodies.spec, "spec", oakridgeCatalogue("spec", versions.spec_body.version));
  const plan = selectRevision(bodies.plan, "plan", oakridgeCatalogue("plan", versions.plan_body.version));
  expect(spec.items.map(({ item }) => [item.item_kind, item.item_scope, item.producer_local_id])).toEqual([
    ["requirement", TASK_SCOPE, "R1"], ["requirement", TASK_SCOPE, "R2"], ["requirement", TASK_SCOPE, "R3"],
  ]);
  expect(plan.items.map(({ item }) => [item.producer_local_id, item.selected_value])).toEqual([
    ["R1", { requirement_id: "R1", contribution: "Contribution A" }],
    ["R1", { requirement_id: "R1", contribution: "Contribution B" }],
    ["R1", { requirement_id: "R1", contribution: "Contribution C" }],
  ]);
});
test("nested analysis findings explicitly link their containing canonical requirement", () => {
  const pass = selectRevision(bodies.analysis, "analysis", oakridgeCatalogue("analysis", versions.analysis_body.version));
  expect(pass.items[0]?.item.links).toEqual([{ target: "logical_item", type: "addresses", target_scope: TASK_SCOPE, target_local_id: "R1", evidence_ref: "/requirements/0/findings/0" }]);
});
test("per_task /requirement_ids config binds build-item grades to only the captured canonical ids", () => {
  canonicalRegistration();
  const brief = selectRevision(bodies.brief, "brief", oakridgeCatalogue("brief", versions.brief_body.version)).items[0]?.item;
  const spec = selectRevision(bodies.spec, "spec", oakridgeCatalogue("spec", versions.spec_body.version)).items;
  if (!brief) throw new Error("No build item");
  const scope = { producer: "oakridge", namespace: "test", run_id: "current" };
  const roots = new Map(spec.map(({ item }) => [item.producer_local_id, logicalItemId({ ...scope, scope: TASK_SCOPE, producer_local_id: item.producer_local_id ?? "" }) as LogicalItemId]));
  const occurrence_id = "brief:B1" as ItemOccurrenceId;
  const relations = brief.links.flatMap((link) => {
    if (link.target !== "logical_item") return [];
    const proposal = logicalItemRelation(occurrence_id, link, roots.get(link.target_local_id) ?? null);
    return [{ source_occurrence_id: occurrence_id, type: proposal.type, evidence_ref: proposal.evidence_ref,
      unresolved_target_ref: proposal.target.kind === "unresolved" ? proposal.target.ref : null,
      target_logical_item_id: proposal.target.kind === "logical_item" ? proposal.target.id : null }];
  });
  expect(gradingSubjects({ occurrence: { occurrence_id, json_pointer: brief.path, selected_value: brief.selected_value },
    scope: { scope: "per_task", task_ids: "/requirement_ids" }, relations }).map((subject) => subject.task_id)).toEqual([roots.get("R1") ?? null, roots.get("R3") ?? null]);
});
test("legacy versions keep legacy selectors even when given a current-shaped body", () => {
  const legacy = oakridgeCatalogue("analysis", "artifact-schema/v1:4847489074cebfe24f7ecdd9024b351f26ccac021f3f10ce2c788bfa8a5d39e2");
  expect(legacy.map((definition) => definition.item_selector)).toContain("/findings/*");
  expect(legacy.map((definition) => definition.item_selector)).not.toContain("/requirements/*/findings/*");
});

function canonicalRegistration() {
  const parsed = parseGradingDefinitions([{ id: "current.brief.verification", scope: "per_task", task_ids: "/requirement_ids",
    targets: [{ artifact: "brief", selector: "/build_items/*" }], evidence: [], evaluators: [{ runner: "human" }],
    question: { text: "Is the requirement covered?", response: "choice", values: ["covered", "missing"], missing_evidence_policy: "abstain", abstain_semantics: "Insufficient evidence", unclear_semantics: "Unclear", interpretation_caveats: "" },
  }], oakridgeGradingRegistry);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  const registration = planRegistration(parsed.value, oakridgeGradingRegistry);
  if (!registration.ok) throw new Error(JSON.stringify(registration.error));
  return registration.value;
}

integration("current capture, requirement rollups and human grades share canonical ids end to end", async () => scratchDatabase(async (db) => {
  const registration = canonicalRegistration();
  const registered = await registerDefinitions(db, tenant, registration);
  if (!registered.ok) throw new Error(registered.error.detail);
  const capture = stampCapture(registration.capture, { config_version: 1, config_hash: "canonical-json/v1:" + "a".repeat(64) });
  const feed = createFeed(db, tenant, capture);
  await feed.launch({ spec: "Original requirements" }, "current");
  for (const [kind, version] of [["analysis", versions.analysis_body.version], ["spec", versions.spec_body.version],
    ["plan", versions.plan_body.version], ["brief", versions.brief_body.version]] as const) {
    const original = revisionOutcome({ revision_id: `current-${kind}`, artifact_kind: kind, run_id: "current", stage: kind === "spec" ? "analysis" : kind,
      body: bodies[kind] });
    if (original.kind !== "artifact_revision") throw new Error("Expected revision outcome");
    await feed.send({ ...original, artifact_schema_version: version, revision: { ...original.revision,
      source: { ...original.revision.source, artifact_schema_version: version } } });
  }
  const profile = oakridgeProfile(registration.questions);
  const rollup = await listRunComposites(db, tenant, profile.composite, "current", { limit: 50, offset: 0 });
  // Observation also tracks analysis requirements; the PWA pages the approved spec ids.
  expect(rollup.items.map((item) => item.producer_local_id)).toEqual(["R1", "R2", "R3", "R4"]);
  const item = await readItemAt(db, tenant, profile.composite, { run_id: "current", source_revision_id: "current-brief", item_path: "/build_items/0" });
  if (!item) throw new Error("Current build item was not captured");
  const sets = await readOccurrenceEvidence(db, tenant, item.occurrence_id);
  const r1 = rollup.items.find((row) => row.producer_local_id === "R1");
  const r3 = rollup.items.find((row) => row.producer_local_id === "R3");
  expect(sets.map((set) => set.task_id).sort()).toEqual([r1?.logical_item_id ?? null, r3?.logical_item_id ?? null].sort());
  const r1Set = sets.find((set) => set.task_id === r1?.logical_item_id);
  if (!r1Set) throw new Error("Canonical R1 question was not pinned");
  await recordCollection(db, tenant, r1Set.evidence_set_id, { state: "ready", references: [{ source: "revision", ref: "subject",
    revision_id: item.source_revision_id, item_path: item.item_path, content: item.selected_value }] });
  const app = createApp({ db, profile, capture_configuration: capture, credentials: {
    ingest: [], read: [{ ...tenant, token: "read" }], grade: [{ ...tenant, token: "grade", reviewer_id: "operator" }],
  } });
  const response = await app.request(`/v1/items/${encodeURIComponent(item.occurrence_id)}/answers`, { method: "POST",
    headers: { authorization: "Bearer grade", "content-type": "application/json" }, body: JSON.stringify({
      submission_id: "canonical-r1-answer", task_id: r1Set.task_id, question_id: r1Set.question_id, question_version: r1Set.question_version, answer: "covered",
    }) });
  expect(response.status).toBe(201);
  const grades = await app.request(`/v1/items/${encodeURIComponent(item.occurrence_id)}/grades?task_id=${encodeURIComponent(r1Set.task_id ?? "")}`, { headers: { authorization: "Bearer read" } });
  expect(grades.status).toBe(200);
  expect(JSON.stringify(await grades.json())).toContain("covered");
}));

integration("a revised finding resolves only in the spec's pinned analysis revision", async () => scratchDatabase(async (db) => {
  const feed = createFeed(db);
  for (const [revision_id, kind, version, body] of [
    ["analysis-old", "analysis", versions.analysis_body.version, bodies.analysis],
    ["analysis-revised", "analysis", versions.analysis_body.version, bodies.analysis],
    ["spec-pinned", "spec", versions.spec_body.version, bodies.spec],
  ] as const) {
    const original = revisionOutcome({ revision_id, artifact_kind: kind, body });
    if (original.kind !== "artifact_revision") throw new Error("Expected revision");
    await feed.send({ ...original, artifact_schema_version: version, revision: { ...original.revision, format: "observation.artifact-revision/v4", source: { ...original.revision.source,
      artifact_schema_version: version, ...(kind === "spec" ? { analysis_revision_ids: ["oakridge:grading-test:analysis-revised"] } : {}),
    } } });
  }
  const { withTenant } = await import("../src/storage/database");
  const links = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation as relation")
    .innerJoin("observation.item_occurrence as source", "source.occurrence_id", "relation.source_occurrence_id")
    .innerJoin("observation.item_occurrence as target", "target.occurrence_id", "relation.target_occurrence_id")
    .select(["source.json_pointer", "target.revision_id", "target.producer_local_id"])
    .where("source.revision_id", "=", "spec-pinned").where("relation.type", "=", "derived_from").orderBy("source.json_pointer").execute());
  expect(links.map((link) => [link.json_pointer, link.revision_id, link.producer_local_id])).toEqual([
    ["/requirements/0", "analysis-revised", "F1"], ["/requirements/1", "analysis-revised", "F3"], ["/requirements/2", "analysis-revised", "F5"],
  ]);
}));
