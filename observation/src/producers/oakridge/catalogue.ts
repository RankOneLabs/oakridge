import { DEVELOPMENT_ARTIFACT_VERSIONS } from "./artifact-versions";
import type { RegisteredSelector } from "../../grading/configuration";
import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import { idList, listAt, objectAt, requiredId, type ExtractionFailure, type ExtractorDefinition,
  type LinkReference, type LogicalItemLink, type OccurrenceLink, type SelectedItem } from "../../projection/extractor";

/** Every task-bearing item is an occurrence of one run-scoped logical task. */
export const TASK_SCOPE = "task";
export const FINDING_KIND = "finding";
export const ASSESSMENT_FINDING_KIND = "assessment_finding";
const ACCEPTANCE_ENTRY_KIND = "acceptance_entry";
const VERSION = "1";

/** These fields mirror workflow-config/development.yaml's development artifact schemas. */
export interface Task { readonly id: string; readonly description: string; readonly requirement_ids: readonly string[] }
/** One task's obligation within a plan cohort or brief; `id` is the task id. */
export interface AcceptanceEntry { readonly id: string; readonly text: string; readonly decision_ids: readonly string[] }
export interface BuildItem { readonly id: string; readonly description: string; readonly task_ids: readonly string[];
  readonly decision_ids: readonly string[]; readonly verification: JsonValue }
export type FindingSubject = { readonly kind: "build_item"; readonly id: string; readonly cohort_id?: string }
  | { readonly kind: "task"; readonly id: string };
export interface AssessmentFinding { readonly task_ids: readonly string[]; readonly evidence: readonly JsonValue[] }

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
export type ActionSource = { readonly kind: "item_assessment"; readonly id: string }
  | { readonly kind: "additional_finding"; readonly id: string };
export interface NextAction {
  readonly id: string; readonly audience: "rework" | "operator"; readonly source: ActionSource; readonly text: string;
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
  links: readonly LinkReference[] = []): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: path, item_scope: TASK_SCOPE, producer_local_id: task_id,
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
function briefList(field: string, map: (value: JsonValue, path: string, cohortId: string) => Result<SelectedItem, ExtractionFailure>)
  : (body: JsonValue) => Result<readonly SelectedItem[], ExtractionFailure> {
  return (body) => {
    const object = objectAt(body, "/");
    if (!object.ok) return object;
    if ((field === "acceptance_criteria" || field === "build_items") && !(field in object.value)) return ok([]);
    const cohortId = object.value.cohort_id;
    if (typeof cohortId !== "string" || cohortId.length === 0)
      return err({ operation: "select_items", entity_id: "/cohort_id", detail: "missing cohort id" });
    const values = listAt(body, [field]);
    return values.ok ? mapped(values.value, `/${field}`, (value, path) => map(value, path, cohortId)) : values;
  };
}
function idsLink(value: JsonValue, field: string, path: string, target_artifact_kind: string,
  target_item_kind: string, target_scope: string | null, type: OccurrenceLink["type"])
  : Result<readonly OccurrenceLink[], ExtractionFailure> {
  const ids = idList(value, field, path);
  return ids.ok ? ok(ids.value.map((target_local_id, index) => ({ target: "occurrence", type, target_artifact_kind,
    target_item_kind, target_scope, target_local_id, evidence_ref: `${path}/${field}/${index}` }))) : ids;
}
/** Each id the finding declares is one `assesses` edge to that task; an empty list is no edge. */
function taskLinks(value: JsonValue, path: string): Result<readonly LogicalItemLink[], ExtractionFailure> {
  const ids = idList(value, "task_ids", path);
  return ids.ok ? ok(ids.value.map((target_local_id, index) => ({ target: "logical_item", type: "assesses",
    target_scope: TASK_SCOPE, target_local_id, evidence_ref: `${path}/task_ids/${index}` }))) : ids;
}
function definition(artifact_kind: string, schema_version: string, extractor_id: string, item_kind: string,
  item_selector: string, select: ExtractorDefinition["select"]): ExtractorDefinition {
  return { artifact_kind, schema_version, extractor_id, extractor_version: VERSION, item_kind, item_selector, select };
}

function legacyDefinitions(schemaVersion: string): readonly ExtractorDefinition[] {
  return [
    definition("analysis", schemaVersion, "analysis.findings", FINDING_KIND, "/findings/*",
      topList("findings", (value, path) => { const id = requiredId(value, path);
        return id.ok ? ok(pathItem(FINDING_KIND, "/findings/*", path, value, [], id.value)) : id; })),
    definition("analysis", schemaVersion, "analysis.requirement_statuses", "requirement_status", "/requirements/*/status",
      topList("requirements", (value, path) => {
        const object = objectAt(value, path);
        if (!object.ok) return object;
        const id = requiredId(value, path);
        if (!id.ok) return id;
        const status = object.value.status;
        return typeof status === "string" ? ok(pathItem("requirement_status", "/requirements/*/status",
          `${path}/status`, status, [], id.value))
          : err({ operation: "select_items", entity_id: `${path}/status`, detail: "missing status" });
      })),
    definition("analysis", schemaVersion, "analysis.proposed_updates", "proposed_spec_update", "/proposed_spec_updates/*",
      topList("proposed_spec_updates", (value, path) => { const links = idsLink(value, "finding_ids", path,
        "analysis", FINDING_KIND, null, "addresses"); return links.ok
        ? ok(pathItem("proposed_spec_update", "/proposed_spec_updates/*", path, value, links.value)) : links; })),
    definition("analysis", schemaVersion, "analysis.risks", "risk", "/risks/*",
      topList("risks", (value, path) => ok(pathItem("risk", "/risks/*", path, value)))),
    definition("tasks", schemaVersion, "tasks.tasks", "task", "/tasks/*",
      topList("tasks", (value, path) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "requirement_ids", path, "analysis", "requirement_status", null, "derived_from");
        return links.ok ? ok(taskItem("task", "/tasks/*", path, id.value, value, links.value)) : links;
      })),
    definition("plan", schemaVersion, "plan.decisions", "decision", "/cohorts/*/decisions/*",
      cohortList("decisions", (value, path, cohortId) => { const id = requiredId(value, path); return id.ok
        ? ok(idItem("decision", "/cohorts/*/decisions/*", path, `cohort/${cohortId}/decision`, id.value, value)) : id; })),
    definition("plan", schemaVersion, "plan.acceptance_entries", ACCEPTANCE_ENTRY_KIND, "/cohorts/*/acceptance_criteria/*",
      cohortList("acceptance_criteria", (value, path, cohortId) => {
        const id = requiredId(value, path);
        if (!id.ok) return id;
        const decisions = idsLink(value, "decision_ids", path, "plan", "decision", `cohort/${cohortId}/decision`, "derived_from");
        return decisions.ok ? ok(taskItem(ACCEPTANCE_ENTRY_KIND, "/cohorts/*/acceptance_criteria/*", path, id.value, value, decisions.value))
          : decisions;
      })),
    definition("plan", schemaVersion, "plan.risks", "risk", "/risks/*",
      topList("risks", (value, path) => ok(pathItem("risk", "/risks/*", path, value)))),
    definition("brief", schemaVersion, "brief.decisions", "decision", "/decisions_made/*",
      briefList("decisions_made", (value, path, cohortId) => { const id = requiredId(value, path);
        return id.ok ? ok(idItem("decision", "/decisions_made/*", path, `cohort/${cohortId}/decision`,
          id.value, value, [{ target: "occurrence", type: "derived_from", target_artifact_kind: "plan", target_item_kind: "decision",
            target_scope: `cohort/${cohortId}/decision`, target_local_id: id.value, evidence_ref: `${path}/id`, if_present: true }])) : id;
      })),
    definition("brief", schemaVersion, "brief.rejected_approaches", "rejected_approach", "/approaches_rejected/*",
      briefList("approaches_rejected", (value, path, cohortId) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "decision_ids", path, "brief", "decision", `cohort/${cohortId}/decision`, "addresses");
        return links.ok ? ok(idItem("rejected_approach", "/approaches_rejected/*", path,
          `cohort/${cohortId}/rejected_approach`, id.value, value, links.value)) : links;
      })),
    definition("brief", schemaVersion, "brief.acceptance_entries", ACCEPTANCE_ENTRY_KIND, "/acceptance_criteria/*",
      briefList("acceptance_criteria", (value, path) => { const id = requiredId(value, path);
        return id.ok ? ok(taskItem(ACCEPTANCE_ENTRY_KIND, "/acceptance_criteria/*", path, id.value, value)) : id;
      })),
    definition("brief", schemaVersion, "brief.build_items", "build_item", "/build_items/*",
      briefList("build_items", (value, path, cohortId) => {
        const id = requiredId(value, path);
        if (!id.ok) return id;
        const tasks = taskLinks(value, path);
        if (!tasks.ok) return tasks;
        const decisions = idsLink(value, "decision_ids", path, "brief", "decision", `cohort/${cohortId}/decision`, "derived_from");
        return decisions.ok ? ok({ ...pathItem("build_item", "/build_items/*", path, value,
          [...tasks.value.map((link) => ({ ...link, type: "addresses" as const })), ...decisions.value], id.value),
          item_scope: `cohort/${cohortId}/build_item` }) : decisions;
      })),
    definition("assessment", schemaVersion, "assessment.subject_findings", ASSESSMENT_FINDING_KIND, "/findings/*",
      shapeFindings("subjects", subjectFinding)),
    definition("assessment", schemaVersion, "assessment.findings", ASSESSMENT_FINDING_KIND, "/findings/*",
      shapeFindings("task_ids", (value, path) => { const links = taskLinks(value, path);
        return links.ok ? ok(pathItem(ASSESSMENT_FINDING_KIND, "/findings/*", path, value, links.value)) : links;
      })),
  ];
}

/** Resolved-body v2 fingerprints emitted by the adapter for the pinned
 * requirement contract; see workflow-config/README.md. Legacy v1 fingerprints
 * and unknown future versions retain legacy extraction. */
export const CURRENT_SCHEMA_VERSIONS = {
  blocker: "artifact-schema/v2:fd7d3d5480c6a7821d205607dc4277d6078ba93c8b3892de4ce4f1877acb96e4",
  analysis: "artifact-schema/v2:ae5a9fb9c1a0cf37fbf047000c36f234da2d338552efe6f97f8a9a59890cdbde",
  spec: "artifact-schema/v2:3e6831d5b78d1a4ac06096edd5901aae62889530f407b8581a71698e4e65ca58",
  plan: "artifact-schema/v2:532d3d3e11f8df58a07618e8093374bb8e3e4f2348fa49a980bbbecb8290174d",
  brief: "artifact-schema/v2:e04f77b836567abab8dc575972e28ad6c16c4fed569e0bbb3cb6653783913969",
  assessment: DEVELOPMENT_ARTIFACT_VERSIONS.assessment_body.version,
} as const;

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
    target_scope: TASK_SCOPE, target_local_id, evidence_ref: `${path}/requirement_ids/${index}` }))) : ids;
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
        [{ target: "logical_item", type: "addresses", target_scope: TASK_SCOPE,
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
    target_scope: TASK_SCOPE, target_local_id: id.value, evidence_ref };
  else if (subject.value.kind === "build_item") link = { target: "occurrence", type: "assesses",
    target_artifact_kind: "brief", target_item_kind: "build_item", target_scope: null,
    target_local_id: id.value, recorded_revisions_field: "brief_revision_ids", evidence_ref };
  else return err({ operation: "select_items", entity_id: `${path}/subject/kind`, detail: "unknown assessment subject" });
  return ok(pathItem("item_assessment", "/item_assessments/*", path, value, [link], id.value));
}
function nextAction(value: JsonValue, path: string): Result<SelectedItem, ExtractionFailure> {
  const id = requiredId(value, path);
  if (!id.ok) return id;
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const source = objectAt(object.value.source ?? null, `${path}/source`);
  if (!source.ok) return source;
  const sourceId = requiredId(source.value, `${path}/source`);
  if (!sourceId.ok) return sourceId;
  const kind = source.value.kind;
  if (kind !== "item_assessment" && kind !== "additional_finding")
    return err({ operation: "select_items", entity_id: `${path}/source/kind`, detail: "unknown action source" });
  return ok(pathItem("next_action", "/next_actions/*", path, value, [{ target: "occurrence", type: "derived_from",
    target_artifact_kind: "assessment", target_item_kind: kind, target_scope: null,
    target_local_id: sourceId.value, evidence_ref: `${path}/source/id` }], id.value));
}
export function currentDefinitions(schemaVersion: string): readonly ExtractorDefinition[] {
  return [
    definition("analysis", schemaVersion, "analysis.requirement_findings", "finding", "/requirements/*/findings/*", nestedFindings),
    definition("analysis", schemaVersion, "analysis.requirements", "requirement", "/requirements/*",
      topList("requirements", (value, path) => { const id = requiredId(value, path);
        return id.ok ? ok(taskItem("requirement", "/requirements/*", path, id.value, value)) : id; })),
    definition("spec", schemaVersion, "spec.requirements", "requirement", "/requirements/*",
      topList("requirements", (value, path) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "analysis_finding_ids", path, "analysis", "finding", null, "derived_from");
        return links.ok ? ok(taskItem("requirement", "/requirements/*", path, id.value, value,
          links.value.map((link) => ({ ...link, recorded_revisions_field: "analysis_revision_ids" })))) : links; })),
    definition("plan", schemaVersion, "plan.allocations", "allocation", "/cohorts/*/allocations/*",
      cohortList("allocations", (value, path, cohortId) => { const id = referenceId(value, "requirement_id", path);
        return id.ok ? ok({ ...taskItem("allocation", "/cohorts/*/allocations/*", path, id.value, value),
          item_scope: `cohort/${cohortId}/allocation`, logical_item: { scope: TASK_SCOPE, producer_local_id: id.value }, links: [{ target: "logical_item", type: "addresses",
            target_scope: TASK_SCOPE, target_local_id: id.value, evidence_ref: `${path}/requirement_id` }] }) : id; })),
    definition("brief", schemaVersion, "brief.requirement_build_items", "build_item", "/build_items/*",
      briefList("build_items", (value, path, cohortId) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = requirementLinks(value, path);
        return links.ok ? ok({ ...pathItem("build_item", "/build_items/*", path, value, links.value, id.value),
          item_scope: `cohort/${cohortId}/build_item` }) : links; })),
    definition("brief", schemaVersion, "brief.technical_decisions", "technical_decision", "/technical_decisions/*",
      briefList("technical_decisions", (value, path, cohortId) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "build_item_ids", path, "brief", "build_item", `cohort/${cohortId}/build_item`, "addresses");
        return links.ok ? ok(idItem("technical_decision", "/technical_decisions/*", path,
          `cohort/${cohortId}/technical_decision`, id.value, value, links.value)) : links; })),
    definition("assessment", schemaVersion, "assessment.item_assessments", "item_assessment", "/item_assessments/*", topList("item_assessments", itemAssessment)),
    definition("assessment", schemaVersion, "assessment.additional_findings", "additional_finding", "/additional_findings/*",
      topList("additional_findings", (value, path) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "related_build_item_ids", path, "brief", "build_item", null, "addresses");
        return links.ok ? ok(pathItem("additional_finding", "/additional_findings/*", path, value,
          links.value.map((link) => ({ ...link, recorded_revisions_field: "brief_revision_ids" })), id.value)) : links; })),
    definition("assessment", schemaVersion, "assessment.next_actions", "next_action", "/next_actions/*", topList("next_actions", nextAction)),
    definition("blocker", schemaVersion, "blocker.body", "blocker", "/", (body) => ok([pathItem("blocker", "/", "", body)])),
  ];
}

/** Unknown versions intentionally retain historical extraction. */
export function definitionsForSchemaVersion(schemaVersion: string): readonly ExtractorDefinition[] {
  return (Object.values(CURRENT_SCHEMA_VERSIONS) as readonly string[]).includes(schemaVersion)
    ? currentDefinitions(schemaVersion) : legacyDefinitions(schemaVersion);
}

export function oakridgeCatalogue(artifact_kind: string, schema_version: string): readonly ExtractorDefinition[] {
  return definitionsForSchemaVersion(schema_version).filter((entry) => entry.artifact_kind === artifact_kind);
}

/** Registered extractor addresses; question bindings belong to published grading configuration. */
export const OAKRIDGE_SELECTORS: readonly RegisteredSelector[] = [...legacyDefinitions(VERSION), ...currentDefinitions(VERSION)].map(({ artifact_kind, item_selector, item_kind }) =>
  ({ artifact_kind, item_selector, item_kind, item_fields: fieldsForItem(item_kind, item_selector) }));

/** Fields mirrored by Task, AcceptanceEntry, AssessmentFinding and the catalogue mappings above. */
function fieldsForItem(item_kind: string, item_selector: string): readonly string[] {
  switch (item_kind) {
    case "task": return ["/id", "/description", "/requirement_ids"];
    case "acceptance_entry": return ["/id", "/text", "/decision_ids"];
    case "assessment_finding": return ["/task_ids", "/subjects", "/evidence"];
    case "build_item": return ["/id", "/description", "/instructions", "/task_ids", "/requirement_ids", "/decision_ids", "/verification"];
    case "finding": return item_selector === "/requirements/*/findings/*"
      ? ["/id", "/severity", "/observation", "/evidence", "/expected_change_locations", "/resolution"]
      : ["/id", "/description", "/severity"];
    case "requirement": return ["/id", "/text", "/acceptance_conditions", "/source_refs", "/analysis_finding_ids"];
    case "allocation": return ["/requirement_id", "/contribution"];
    case "technical_decision": return ["/id", "/build_item_ids", "/decision", "/rationale"];
    case "item_assessment": return ["/subject/id", "/subject", "/status", "/observation", "/evidence"];
    case "additional_finding": return ["/id", "/severity", "/observation", "/related_build_item_ids", "/evidence"];
    case "next_action": return ["/id", "/audience", "/source", "/text"];
    case "blocker": return ["/text", "/suggested_choices"];
    default: return [];
  }
}

function subjectFinding(value: JsonValue, path: string): Result<SelectedItem, ExtractionFailure> {
  const subjects = listAt(value, ["subjects"]);
  if (!subjects.ok) return subjects;
  const links: LinkReference[] = [];
  for (const [index, subject] of subjects.value.entries()) {
    const object = objectAt(subject, path);
    if (!object.ok) return object;
    const id = requiredId(subject, path);
    if (!id.ok) return id;
    const evidence_ref = `${path}/subjects/${index}`;
    if (object.value.kind === "task") links.push({ target: "logical_item", type: "assesses", target_scope: TASK_SCOPE, target_local_id: id.value, evidence_ref });
    else if (object.value.kind === "build_item") links.push({ target: "occurrence", type: "assesses", target_artifact_kind: "brief", target_item_kind: "build_item", recorded_revisions_field: "brief_revision_ids",
      target_scope: typeof object.value.cohort_id === "string" ? `cohort/${object.value.cohort_id}/build_item` : null,
      target_local_id: id.value, evidence_ref });
    else return err({ operation: "select_items", entity_id: evidence_ref, detail: "unknown finding subject" });
  }
  return ok(pathItem(ASSESSMENT_FINDING_KIND, "/findings/*", path, value, links));
}

function shapeFindings(field: string, map: Mapping): ExtractorDefinition["select"] {
  return (body) => {
    const values = listAt(body, ["findings"]);
    if (!values.ok) return values;
    const items: SelectedItem[] = [];
    for (const [index, value] of values.value.entries()) {
      const object = objectAt(value, `/findings/${index}`);
      if (!object.ok) return object;
      if (!(field in object.value)) continue;
      const item = map(value, `/findings/${index}`);
      if (!item.ok) return item;
      items.push(item.value);
    }
    return ok(items);
  };
}
