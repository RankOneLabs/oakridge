import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import { idList, listAt, objectAt, requiredId, type ExtractionFailure, type ExtractorDefinition,
  type LinkReference, type SelectedItem } from "../extractor";

/** Criterion identity is flat and run-unique: a criterion outlives the cohort it was
 * planned in, so a renameable cohort id must not form part of its identity. */
export const CRITERION_SCOPE = "criterion";

/** These fields mirror workflow-config/development.yaml's development artifact schemas. */
export interface Finding { readonly id: string; readonly description: string; readonly severity: string }
export interface Requirement { readonly id: string; readonly description: string; readonly status: string }
export interface SpecUpdate { readonly section: string; readonly change: string; readonly reason: string; readonly finding_ids: readonly string[] }
export interface Task { readonly id: string; readonly description: string; readonly requirement_ids: readonly string[] }
export interface PlanCriterion { readonly id: string; readonly text: string; readonly task_ids: readonly string[]; readonly decision_ids: readonly string[] }
export interface PlanCohort { readonly id: string; readonly decisions: readonly { readonly id: string; readonly text: string }[];
  readonly acceptance_criteria: readonly PlanCriterion[] }
export interface BriefBody { readonly cohort_id: string; readonly decisions_made: readonly { readonly id: string; readonly decision: string }[];
  readonly approaches_rejected: readonly { readonly id: string; readonly approach: string; readonly decision_ids: readonly string[] }[];
  readonly acceptance_criteria: readonly PlanCriterion[] }
export interface AssessmentFinding { readonly criterion_id?: string; readonly evidence: readonly JsonValue[] }

export const VERSION = "1";
type Mapping = (value: JsonValue, path: string) => Result<SelectedItem, ExtractionFailure>;

function pathItem(item_kind: string, item_selector: string, path: string, selected_value: JsonValue,
  links: readonly LinkReference[] = [], producer_local_id: string | null = null): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: path, item_scope: null, producer_local_id,
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
    const cohortId = object.value.cohort_id;
    if (typeof cohortId !== "string" || cohortId.length === 0)
      return err({ operation: "select_items", entity_id: "/cohort_id", detail: "missing cohort id" });
    const values = listAt(body, [field]);
    return values.ok ? mapped(values.value, `/${field}`, (value, path) => map(value, path, cohortId)) : values;
  };
}
function idsLink(value: JsonValue, field: string, path: string, target_artifact_kind: string,
  target_item_kind: string, target_scope: string | null, type: LinkReference["type"])
  : Result<readonly LinkReference[], ExtractionFailure> {
  const ids = idList(value, field, path);
  return ids.ok ? ok(ids.value.map((target_local_id, index) => ({ type, target_artifact_kind, target_item_kind,
    target_scope, target_local_id, evidence_ref: `${path}/${field}/${index}` }))) : ids;
}
function definition(artifact_kind: string, schema_version: string, extractor_id: string, item_kind: string,
  item_selector: string, select: ExtractorDefinition["select"]): ExtractorDefinition {
  return { artifact_kind, schema_version, extractor_id, extractor_version: VERSION, item_kind, item_selector, select };
}

/** Register selections against the captured revision's pinned schema version. */
export function oakridgeDevelopmentCatalogue(artifactKind: string, schemaVersion: string): readonly ExtractorDefinition[] {
  const definitions: ExtractorDefinition[] = [
    definition("analysis", schemaVersion, "analysis.findings", "finding", "/findings/*",
      topList("findings", (value, path) => { const id = requiredId(value, path); return id.ok
        ? ok(idItem("finding", "/findings/*", path, "analysis/finding", id.value, value)) : id; })),
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
        "analysis", "finding", "analysis/finding", "addresses"); return links.ok
        ? ok(pathItem("proposed_spec_update", "/proposed_spec_updates/*", path, value, links.value)) : links; })),
    definition("analysis", schemaVersion, "analysis.risks", "risk", "/risks/*",
      topList("risks", (value, path) => ok(pathItem("risk", "/risks/*", path, value)))),
    definition("tasks", schemaVersion, "tasks.tasks", "task", "/tasks/*",
      topList("tasks", (value, path) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "requirement_ids", path, "analysis", "requirement_status", null, "derived_from");
        return links.ok ? ok(idItem("task", "/tasks/*", path, "tasks", id.value, value, links.value)) : links;
      })),
    definition("plan", schemaVersion, "plan.decisions", "decision", "/cohorts/*/decisions/*",
      cohortList("decisions", (value, path, cohortId) => { const id = requiredId(value, path); return id.ok
        ? ok(idItem("decision", "/cohorts/*/decisions/*", path, `cohort/${cohortId}/decision`, id.value, value)) : id; })),
    definition("plan", schemaVersion, "plan.criteria", "criterion", "/cohorts/*/acceptance_criteria/*",
      cohortList("acceptance_criteria", (value, path, cohortId) => {
        const id = requiredId(value, path);
        if (!id.ok) return id;
        const tasks = idsLink(value, "task_ids", path, "tasks", "task", "tasks", "derived_from");
        if (!tasks.ok) return tasks;
        const decisions = idsLink(value, "decision_ids", path, "plan", "decision", `cohort/${cohortId}/decision`, "derived_from");
        return decisions.ok ? ok(idItem("criterion", "/cohorts/*/acceptance_criteria/*", path,
          CRITERION_SCOPE, id.value, value, [...tasks.value, ...decisions.value])) : decisions;
      })),
    definition("plan", schemaVersion, "plan.acceptance_criteria", "plan_wide_criterion", "/acceptance_criteria/*",
      topList("acceptance_criteria", (value, path) => typeof value === "string"
        ? ok(pathItem("plan_wide_criterion", "/acceptance_criteria/*", path, value))
        : err({ operation: "select_items", entity_id: path, detail: "expected text" }))),
    definition("plan", schemaVersion, "plan.risks", "risk", "/risks/*",
      topList("risks", (value, path) => ok(pathItem("risk", "/risks/*", path, value)))),
    definition("brief", schemaVersion, "brief.decisions", "decision", "/decisions_made/*",
      briefList("decisions_made", (value, path, cohortId) => { const id = requiredId(value, path);
        return id.ok ? ok(idItem("decision", "/decisions_made/*", path, `cohort/${cohortId}/decision`,
          id.value, value, [{ type: "derived_from", target_artifact_kind: "plan", target_item_kind: "decision",
            target_scope: `cohort/${cohortId}/decision`, target_local_id: id.value, evidence_ref: `${path}/id`, if_present: true }])) : id;
      })),
    definition("brief", schemaVersion, "brief.rejected_approaches", "rejected_approach", "/approaches_rejected/*",
      briefList("approaches_rejected", (value, path, cohortId) => { const id = requiredId(value, path);
        if (!id.ok) return id;
        const links = idsLink(value, "decision_ids", path, "brief", "decision", `cohort/${cohortId}/decision`, "addresses");
        return links.ok ? ok(idItem("rejected_approach", "/approaches_rejected/*", path,
          `cohort/${cohortId}/rejected_approach`, id.value, value, links.value)) : links;
      })),
    definition("brief", schemaVersion, "brief.criteria", "criterion", "/acceptance_criteria/*",
      briefList("acceptance_criteria", (value, path) => { const id = requiredId(value, path);
        return id.ok ? ok(idItem("criterion", "/acceptance_criteria/*", path, CRITERION_SCOPE,
          id.value, value, [{ type: "derived_from", target_artifact_kind: "plan", target_item_kind: "criterion",
          target_scope: CRITERION_SCOPE, target_local_id: id.value, evidence_ref: `${path}/id`, if_present: true }])) : id;
      })),
    definition("assessment", schemaVersion, "assessment.findings", "assessment_finding", "/findings/*",
      topList("findings", (value, path) => { const object = objectAt(value, path);
        if (!object.ok) return object;
        const criterionId = object.value.criterion_id;
        if (criterionId !== undefined && criterionId !== null && typeof criterionId !== "string")
          return err({ operation: "select_items", entity_id: `${path}/criterion_id`, detail: "invalid criterion id" });
        const links: LinkReference[] = typeof criterionId === "string" ? [{ type: "assesses", target_artifact_kind: "brief",
          target_item_kind: "criterion", target_scope: CRITERION_SCOPE, target_local_id: criterionId,
          evidence_ref: `${path}/criterion_id` }] : [];
        return ok(pathItem("assessment_finding", "/findings/*", path, value, links));
      })),
  ];
  return definitions.filter((entry) => entry.artifact_kind === artifactKind);
}
