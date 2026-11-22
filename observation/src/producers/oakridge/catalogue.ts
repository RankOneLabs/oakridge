import { ARTIFACT_KEYS, type ArtifactKey } from "./artifact-versions";
import type { RegisteredSelector } from "../../grading/configuration";
import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import { idList, listAt, objectAt, requiredId, type ExtractionFailure, type ExtractorDefinition,
  type LinkReference, type LogicalItemLink, type OccurrenceLink, type SelectedItem } from "../../projection/extractor";

/** Every task-bearing item is an occurrence of one run-scoped logical task. */
export const TASK_SCOPE = "task";
export const FINDING_KIND = "finding";
const VERSION = "1";

/** Current-contract item models mirror the named schemas in development.yaml. */
export interface Requirement {
  readonly id: string; readonly text: string; readonly acceptance_conditions: readonly string[];
  readonly source_refs: readonly string[]; readonly analysis_finding_ids: readonly string[];
}
export interface Allocation { readonly requirement_id: string; readonly contribution: string }
export interface RequirementBuildItem {
  readonly id: string; readonly requirement_ids: readonly string[]; readonly instructions: string;
  readonly verification: readonly string[];
}
export interface TechnicalDecision {
  readonly id: string; readonly build_item_ids: readonly string[]; readonly decision: string; readonly rationale: string;
}
export type AssessmentSubject = { readonly kind: "build_item"; readonly id: string }
  | { readonly kind: "requirement"; readonly id: string };
export interface EvidenceRef { readonly kind: "file" | "test" | "output"; readonly ref: string; readonly detail?: string }
export interface ItemAssessment {
  readonly subject: AssessmentSubject; readonly status: "met" | "partial" | "not_met";
  readonly observation: string; readonly evidence: readonly EvidenceRef[];
}
export interface AdditionalFinding {
  readonly id: string; readonly severity: "blocking" | "warning" | "info"; readonly observation: string;
  readonly related_build_item_ids: readonly string[]; readonly evidence: readonly EvidenceRef[];
}
export interface Blocker { readonly text: string; readonly suggested_choices?: readonly string[] }

type Mapping = (value: JsonValue, path: string) => Result<SelectedItem, ExtractionFailure>;

/** Addressed by revision and path alone: the identity holds no task id. */
function pathItem(item_kind: string, item_selector: string, path: string, selected_value: JsonValue,
  links: readonly LinkReference[] = [], producer_local_id: string | null = null): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: path, item_scope: null, producer_local_id,
    selected_value, path, links };
}
function taskItem(item_kind: string, item_selector: string, path: string, task_id: string, selected_value: JsonValue,
  links: readonly LinkReference[] = [], task_kind = "requirement"): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: path, item_scope: TASK_SCOPE, producer_local_id: task_id,
    logical_item: { scope: TASK_SCOPE, task_kind, producer_local_id: task_id },
    selected_value, path, links };
}
function idItem(item_kind: string, item_selector: string, path: string, scope: string,
  localId: string, selected_value: JsonValue, links: readonly LinkReference[] = []): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: `${scope}:${localId}`, item_scope: scope,
    producer_local_id: localId, selected_value, path, links };
}
function mapped(values: readonly JsonValue[], prefix: string, map: Mapping): Result<readonly SelectedItem[], ExtractionFailure> {
  const items: SelectedItem[] = [];
  for (const [index, value] of values.entries()) {
    const item = map(value, `${prefix}/${index}`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return ok(items);
}
function topList(field: string, map: Mapping): (body: JsonValue) => Result<readonly SelectedItem[], ExtractionFailure> {
  return (body) => {
    const values = listAt(body, [field]);
    return values.ok ? mapped(values.value, `/${field}`, map) : values;
  };
}
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
    const repository = referenceId(body, "repository_key", "");
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
type Extractor = Omit<ExtractorDefinition, "artifact_kind" | "schema_version">;
export interface Registration { readonly key: ArtifactKey; readonly extractors: readonly ExtractorDefinition[] }
function definition(extractor_id: string, item_kind: string, item_selector: string, select: ExtractorDefinition["select"]): Extractor {
  return { extractor_id, extractor_version: VERSION, item_kind, item_selector, select };
}
function register(key: ArtifactKey, extractors: readonly Extractor[]): Registration {
  return { key, extractors: extractors.map((extractor) => ({ ...extractor, artifact_kind: key.artifact, schema_version: key.schema_version })) };
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
const study = ARTIFACT_KEYS.study;
export const OAKRIDGE_REGISTRATIONS: readonly Registration[] = [
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
  register(ARTIFACT_KEYS.$core["*"].blocker, [
    definition("blocker.body", "blocker", "/", (body) => ok([pathItem("blocker", "/", "", body)])),
  ]),
  ...studyRegistrations(),
  ...[
    development.cohort.build_result, development.cohort.observed_state, development.cohort.pr, development.cohort.pr_state,
    development.integration.manual_merge_target, development.integration.observed_state, development.integration.pr, development.integration.pr_state,
    development.prepare.workspace,
    ARTIFACT_KEYS["fan-out"].item.result, ARTIFACT_KEYS["fan-out"].prepare.workspace,
    ARTIFACT_KEYS["review-loop"].document.critique, ARTIFACT_KEYS["review-loop"].document.draft,
    study.design.observed_state, study.design.pr, study.design.pr_state, study.design.spend_request,
    study.expand.observed_state, study.expand.pr, study.expand.pr_state,
    study.freeze.observed_state, study.freeze.pr, study.freeze.pr_state,
    study.integration.manual_merge_target, study.integration.observed_state, study.integration.pr, study.integration.pr_state,
    study.prepare.workspace,
  ].map((key) => register(key, [])),
];

export interface RegistrationLookup {
  readonly definition_id: string;
  readonly stage: string;
  readonly artifact_kind: string;
  readonly artifact_schema_version: string;
}
export function selectRegistration(capture: RegistrationLookup, registrations = OAKRIDGE_REGISTRATIONS): Registration | undefined {
  return registrations.find(({ key }) => key.artifact === capture.artifact_kind && key.schema_version === capture.artifact_schema_version
    && (key.workflow === "$core" || (key.definition_id === capture.definition_id && key.stage === capture.stage)));
}

export const OAKRIDGE_SELECTORS: readonly RegisteredSelector[] = [...new Map(OAKRIDGE_REGISTRATIONS
  .flatMap(({ extractors }) => extractors.map(({ artifact_kind, item_selector, item_kind }) =>
    [JSON.stringify([artifact_kind, item_selector, item_kind]), { artifact_kind, item_selector, item_kind,
      item_fields: fieldsForItem(item_kind) }] as const))).values()];

function fieldsForItem(item_kind: string): readonly string[] {
  switch (item_kind) {
    case "build_item": return ["/id", "/instructions", "/requirement_ids", "/verification"];
    case "finding": return ["/id", "/severity", "/observation", "/evidence", "/expected_change_locations", "/resolution"];
    case "requirement": return ["/id", "/text", "/acceptance_conditions", "/source_refs", "/analysis_finding_ids"];
    case "allocation": return ["/requirement_id", "/contribution"];
    case "technical_decision": return ["/id", "/build_item_ids", "/decision", "/rationale"];
    case "item_assessment": return ["/subject/id", "/subject", "/status", "/observation", "/evidence"];
    case "additional_finding": return ["/id", "/severity", "/observation", "/related_build_item_ids", "/related_subjects", "/evidence"];
    case "feedback_proposal": return ["/key", "/instruction", "/citation"];
    case "assignment_verification": return ["/round_id", "/outcome"];
    case "case": return ["/id", "/group", "/is_control"];
    case "criterion": case "trigger": return ["/id", "/text"];
    case "cohort_file": return ["/id", "/case_ids", "/groups", "/file", "/digest", "/attempt_count", "/cap_cents", "/cost_basis"];
    case "qualification": return ["/case_id", "/reference_passes", "/omissions_isolated", "/controls_replayed", "/detail"];
    case "paid_result": return ["/case_id", "/model_id", "/outcome", "/detail", "/spend_cents", "/launch_command", "/store_path"];
    case "criterion_mark": case "trigger_mark": return ["/id", "/status", "/evidence"];
    case "hypothesis": return ["/id", "/statement"];
    case "outcome": return ["/id", "/rule"];
    case "blocker": return ["/text", "/suggested_choices"];
    default: return [];
  }
}


type StudyKind = "case" | "criterion" | "trigger" | "cohort_file";
const isStudyKind = (value: JsonValue | undefined): value is StudyKind =>
  value === "case" || value === "criterion" || value === "trigger" || value === "cohort_file";

function studyTaskLink(type: LogicalItemLink["type"], target_task_kind: StudyKind, target_local_id: string, evidence_ref: string): LogicalItemLink {
  return { target: "logical_item", type, target_scope: TASK_SCOPE, target_task_kind, target_local_id, evidence_ref };
}
function studySubject(value: JsonValue, path: string, type: LogicalItemLink["type"]): Result<LogicalItemLink, ExtractionFailure> {
  const id = requiredId(value, path);
  if (!id.ok) return id;
  const subject = objectAt(value, path);
  if (!subject.ok) return subject;
  const kind = subject.value.kind;
  return isStudyKind(kind) ? ok(studyTaskLink(type, kind, id.value, path)) :
    err({ operation: "select_items", entity_id: path, detail: "unknown study subject kind" });
}
function studyTask(path: readonly string[], kind: StudyKind): Extractor {
  const field = path.join("/");
  const selector = `/${field}/*`;
  return definition(`study.${kind}`, kind, selector, (body) => {
    const items = listAt(body, path);
    return items.ok ? mapped(items.value, `/${field}`, (value, address) => {
      const id = requiredId(value, address);
      return id.ok ? ok(taskItem(kind, selector, address, id.value, value, [], kind)) : id;
    }) : items;
  });
}
function studyMark(field: string, item_kind: string, task_kind: StudyKind, idField: string): Extractor {
  const selector = `/${field}/*`;
  return definition(`study.${field}`, item_kind, selector, topList(field, (value, address) => {
    const id = referenceId(value, idField, address);
    return id.ok ? ok(pathItem(item_kind, selector, address, value,
      [studyTaskLink("assesses", task_kind, id.value, `${address}/${idField}`)], id.value)) : id;
  }));
}
function studyRegistrations(): readonly Registration[] {
  const qualifications = studyMark("qualifications", "qualification", "case", "case_id");
  const assessment = [
    definition("assessment.item_assessments", "item_assessment", "/item_assessments/*", topList("item_assessments", (value, path) => {
      const object = objectAt(value, path);
      if (!object.ok) return object;
      const link = studySubject(object.value.subject ?? null, `${path}/subject`, "assesses");
      return link.ok ? ok(pathItem("item_assessment", "/item_assessments/*", path, value, [link.value], link.value.target_local_id)) : link;
    })),
    definition("assessment.additional_findings", "additional_finding", "/additional_findings/*", topList("additional_findings", (value, path) => {
      const id = requiredId(value, path);
      if (!id.ok) return id;
      const subjects = listAt(value, ["related_subjects"]);
      if (!subjects.ok) return subjects;
      const links: LogicalItemLink[] = [];
      for (const [index, subject] of subjects.value.entries()) {
        const link = studySubject(subject, `${path}/related_subjects/${index}`, "addresses");
        if (!link.ok) return link;
        links.push(link.value);
      }
      return ok(pathItem("additional_finding", "/additional_findings/*", path, value, links, id.value));
    })),
    ...assessmentFeedback,
  ];
  return [
    register(study.design.plan, [studyTask(["cases"], "case"), studyTask(["slice", "criteria"], "criterion"),
      studyTask(["iteration_triggers"], "trigger"), ...[["hypotheses", "hypothesis"], ["outcomes", "outcome"]].map(([field, kind]) => {
        const selector = `/${field}/*`;
        return definition(`plan.${field}`, kind!, selector, topList(field!, (value, path) => ok(pathItem(kind!, selector, path, value))));
      })]),
    register(study.design.slice_build, [qualifications]),
    register(study.expand.expansion, [qualifications]),
    register(study.design.slice_report, [studyMark("criteria_marks", "criterion_mark", "criterion", "id"),
      studyMark("trigger_marks", "trigger_mark", "trigger", "id"), studyMark("paid_results", "paid_result", "case", "case_id")]),
    register(study.design.slice_assessment, assessment),
    register(study.expand.assessment, assessment),
    register(study.integration.assessment, assessment),
    register(study.freeze.freeze, [definition("freeze.cohorts", "cohort_file", "/cohorts/*", topList("cohorts", (value, path) => {
      const id = requiredId(value, path);
      if (!id.ok) return id;
      const cases = idList(value, "case_ids", path);
      return cases.ok ? ok(taskItem("cohort_file", "/cohorts/*", path, id.value, value,
        cases.value.map((caseId, index) => studyTaskLink("addresses", "case", caseId, `${path}/case_ids/${index}`)), "cohort_file")) : cases;
    }))]),
  ];
}
