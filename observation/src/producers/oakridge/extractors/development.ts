import { ARTIFACT_KEYS } from "../artifact-versions";
import { err, ok, type JsonValue, type Result } from "../../../domain/primitives";
import { idList, listAt, objectAt, requiredId, type ExtractionFailure, type LinkReference, type OccurrenceLink, type LogicalItemLink, type SelectedItem } from "../../../projection/extractor";
import { TASK_SCOPE, definition, register, mapped, idItem, pathItem, taskItem, topList, type Registration } from "../extractor-helpers";

function cohortList(field: string, map: (value: JsonValue, path: string, cohortId: string) => Result<SelectedItem, ExtractionFailure>)
  : (body: JsonValue) => Result<readonly SelectedItem[], ExtractionFailure> {
  return (body) => {
    const cohorts = listAt(body, ["cohorts"]);
    if (!cohorts.ok) return cohorts;
    const all: SelectedItem[] = [];
    for (const [index, cohort] of cohorts.value.entries()) {
      const cohortPath = `/cohorts/${index}`;
      const id = requiredId(cohort, cohortPath);
      if (!id.ok) return id;
      const values = listAt(cohort, [field]);
      if (!values.ok) return values;
      const selected = mapped(values.value, `${cohortPath}/${field}`, (value, path) => map(value, path, id.value));
      if (!selected.ok) return selected;
      all.push(...selected.value);
    }
    return ok(all);
  };
}
function briefList(field: string, map: (value: JsonValue, path: string, scope: { cohort_id: string; repository_key: string }) => Result<SelectedItem, ExtractionFailure>)
  : (body: JsonValue) => Result<readonly SelectedItem[], ExtractionFailure> {
  return (body) => {
    const object = objectAt(body, "/");
    if (!object.ok) return object;
    const cohort = referenceId(body, "cohort_id", "");
    if (!cohort.ok) return cohort;
    const repository = referenceId(body, "assigned_repository", "");
    if (!repository.ok) return repository;
    const values = listAt(body, [field]);
    return values.ok ? mapped(values.value, `/${field}`, (value, path) => map(value, path, { cohort_id: cohort.value, repository_key: repository.value })) : values;
  };
}
function idsLink(value: JsonValue, field: string, path: string, target_artifact_kind: string,
  target_item_kind: string, target_scope: string | null, type: OccurrenceLink["type"])
  : Result<readonly OccurrenceLink[], ExtractionFailure> {
  const ids = idList(value, field, path);
  return ids.ok ? ok(ids.value.map((target_local_id, index) => ({ target: "occurrence", type, target_artifact_kind,
    target_item_kind, target_scope, target_local_id, evidence_ref: `${path}/${field}/${index}` }))) : ids;
}
function referenceId(value: JsonValue, field: string, path: string): Result<string, ExtractionFailure> {
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const id = object.value[field];
  return typeof id === "string" && id.length > 0 ? ok(id)
    : err({ operation: "select_items", entity_id: `${path}/${field}`, detail: "missing reference id" });
}
function requirementLinks(value: JsonValue, path: string): Result<readonly LogicalItemLink[], ExtractionFailure> {
  const ids = idList(value, "requirement_ids", path);
  return ids.ok ? ok(ids.value.map((target_local_id, index) => ({ target: "logical_item", type: "addresses",
    target_scope: TASK_SCOPE, target_task_kind: "requirement", target_local_id, evidence_ref: `${path}/requirement_ids/${index}` }))) : ids;
}
function nestedFindings(body: JsonValue): Result<readonly SelectedItem[], ExtractionFailure> {
  const requirements = listAt(body, ["requirements"]);
  if (!requirements.ok) return requirements;
  const items: SelectedItem[] = [];
  for (const [index, requirement] of requirements.value.entries()) {
    const path = `/requirements/${index}`;
    const requirementId = requiredId(requirement, path);
    if (!requirementId.ok) return requirementId;
    const findings = listAt(requirement, ["findings"]);
    if (!findings.ok) return err({ ...findings.error, entity_id: `${path}/findings` });
    const selected = mapped(findings.value, `${path}/findings`, (value, findingPath) => {
      const id = requiredId(value, findingPath);
      return id.ok ? ok(pathItem("finding", "/requirements/*/findings/*", findingPath, value,
        [{ target: "logical_item", type: "addresses", target_scope: TASK_SCOPE, target_task_kind: "requirement",
          target_local_id: requirementId.value, evidence_ref: findingPath }], id.value)) : id;
    });
    if (!selected.ok) return selected;
    items.push(...selected.value);
  }
  return ok(items);
}
function itemAssessment(value: JsonValue, path: string): Result<SelectedItem, ExtractionFailure> {
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const subject = objectAt(object.value.subject ?? null, `${path}/subject`);
  if (!subject.ok) return subject;
  const id = requiredId(subject.value, `${path}/subject`);
  if (!id.ok) return id;
  const evidence_ref = `${path}/subject/id`;
  let link: LinkReference;
  if (subject.value.kind === "requirement") link = { target: "logical_item", type: "assesses",
    target_scope: TASK_SCOPE, target_task_kind: "requirement", target_local_id: id.value, evidence_ref };
  else if (subject.value.kind === "build_item") link = { target: "occurrence", type: "assesses",
    target_artifact_kind: "brief", target_item_kind: "build_item", target_scope: null,
    target_local_id: id.value, target_bound: true, evidence_ref };
  else return err({ operation: "select_items", entity_id: `${path}/subject/kind`, detail: "unknown assessment subject" });
  return ok(pathItem("item_assessment", "/item_assessments/*", path, value, [link], id.value));
}
function proposal(value: JsonValue, path: string): Result<SelectedItem, ExtractionFailure> {
  const key = referenceId(value, "key", path);
  if (!key.ok) return key;
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const citation = object.value.citation;
  const links: LinkReference[] = [];
  if (citation != null) {
    const revision = referenceId(citation, "revision_id", `${path}/citation`);
    if (!revision.ok) return revision;
    const cited = objectAt(citation, `${path}/citation`);
    if (!cited.ok) return cited;
    const { pointer } = cited.value;
    if (typeof pointer !== "string") return err({ operation: "select_items", entity_id: path, detail: "citation pointer is required" });
    links.push({ target: "address", type: "derived_from", revision_id: revision.value, pointer, evidence_ref: `${path}/citation` });
  }
  return ok(pathItem("feedback_proposal", "/proposals/*", path, value, links, key.value));
}
const assessmentFeedback = [
  definition("assessment.proposals", "feedback_proposal", "/proposals/*", topList("proposals", proposal)),
  definition("assessment.verifications", "assignment_verification", "/verifications/*",
    topList("verifications", (value, path) => ok(pathItem("assignment_verification", "/verifications/*", path, value)))),
];
const development = ARTIFACT_KEYS.development;
export const registrations: readonly Registration[] = [
  register(development.analysis.analysis, [
    definition("analysis.requirement_findings", "finding", "/requirements/*/findings/*", nestedFindings),
    definition("analysis.requirements", "requirement", "/requirements/*",
      topList("requirements", (value, path) => { const id = requiredId(value, path);
        return id.ok ? ok(taskItem("requirement", "/requirements/*", path, id.value, value)) : id; })),
  ]),
  register(development.analysis.spec, [
    definition("spec.requirements", "requirement", "/requirements/*",
      topList("requirements", (value, path) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "analysis_finding_ids", path, "analysis", "finding", null, "derived_from");
        return links.ok ? ok(taskItem("requirement", "/requirements/*", path, id.value, value,
          links.value.map((link) => ({ ...link, target_bound: true })))) : links; })),
  ]),
  register(development.planning.plan, [
    definition("plan.allocations", "allocation", "/cohorts/*/allocations/*",
      cohortList("allocations", (value, path, cohortId) => { const id = referenceId(value, "requirement_id", path);
        return id.ok ? ok({ ...taskItem("allocation", "/cohorts/*/allocations/*", path, id.value, value),
          item_scope: `cohort/${cohortId}/allocation`, logical_item: { scope: TASK_SCOPE, task_kind: "requirement", producer_local_id: id.value }, links: [{ target: "logical_item", type: "addresses",
            target_scope: TASK_SCOPE, target_task_kind: "requirement", target_local_id: id.value, evidence_ref: `${path}/requirement_id` }] }) : id; })),
  ]),
  register(development.brief.brief, [
    definition("brief.requirement_build_items", "build_item", "/build_items/*",
      briefList("build_items", (value, path, { cohort_id, repository_key }) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = requirementLinks(value, path);
        return links.ok ? ok({ ...pathItem("build_item", "/build_items/*", path, value, links.value.map((link) => ({ ...link, qualifier: { repository_key } })), id.value),
          item_scope: `cohort/${cohort_id}/build_item` }) : links; })),
    definition("brief.technical_decisions", "technical_decision", "/technical_decisions/*",
      briefList("technical_decisions", (value, path, { cohort_id: cohortId }) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "build_item_ids", path, "brief", "build_item", `cohort/${cohortId}/build_item`, "addresses");
        return links.ok ? ok(idItem("technical_decision", "/technical_decisions/*", path,
          `cohort/${cohortId}/technical_decision`, id.value, value, links.value)) : links; })),
  ]),
  ...[development.cohort.assessment, development.integration.assessment].map((key) => register(key, [
    definition("assessment.item_assessments", "item_assessment", "/item_assessments/*", topList("item_assessments", itemAssessment)),
    definition("assessment.additional_findings", "additional_finding", "/additional_findings/*",
      topList("additional_findings", (value, path) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "related_build_item_ids", path, "brief", "build_item", null, "addresses");
        return links.ok ? ok(pathItem("additional_finding", "/additional_findings/*", path, value,
          links.value.map((link) => ({ ...link, target_bound: true })), id.value)) : links; })),
    ...assessmentFeedback,
  ])),
  ...[
    development.cohort.build_result, development.cohort.observed_state, development.cohort.pr, development.cohort.pr_state,
    development.integration.manual_merge_target, development.integration.observed_state, development.integration.pr, development.integration.pr_state,
    development.repository_setup.workspace,
  ].map((key) => register(key, [])),
];
