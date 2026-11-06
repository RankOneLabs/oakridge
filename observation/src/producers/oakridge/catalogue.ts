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
export interface AssessmentFinding { readonly task_ids: readonly string[]; readonly evidence: readonly JsonValue[] }

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

function allDefinitions(schemaVersion: string): readonly ExtractorDefinition[] {
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
    definition("assessment", schemaVersion, "assessment.findings", ASSESSMENT_FINDING_KIND, "/findings/*",
      topList("findings", (value, path) => { const links = taskLinks(value, path);
        return links.ok ? ok(pathItem(ASSESSMENT_FINDING_KIND, "/findings/*", path, value, links.value)) : links;
      })),
  ];
}

export function oakridgeCatalogue(artifact_kind: string, schema_version: string): readonly ExtractorDefinition[] {
  return allDefinitions(schema_version).filter((entry) => entry.artifact_kind === artifact_kind);
}
