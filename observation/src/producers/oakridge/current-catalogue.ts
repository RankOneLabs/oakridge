import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import { idList, listAt, objectAt, requiredId, type ExtractionFailure, type ExtractorDefinition, type LogicalItemLink, type SelectedItem } from "../../projection/extractor";
import { DEVELOPMENT_ARTIFACT_VERSIONS } from "./artifact-versions";

/** Canonical requirement ids are the roots of the existing run-scoped composite API.
 * The wire's per_task scope and task routes stay stable for both pinned contracts. */
export function currentSchemaVersion(artifact: string): string | null {
  switch (artifact) {
    case "analysis": return DEVELOPMENT_ARTIFACT_VERSIONS.analysis_body.version;
    case "spec": return DEVELOPMENT_ARTIFACT_VERSIONS.spec_body.version;
    case "plan": return DEVELOPMENT_ARTIFACT_VERSIONS.plan_body.version;
    case "brief": return DEVELOPMENT_ARTIFACT_VERSIONS.brief_body.version;
    default: return null;
  }
}
type Selection = ExtractorDefinition["select"];
type Mapping = (value: JsonValue, path: string) => Result<SelectedItem, ExtractionFailure>;
interface CurrentListInput { readonly body: JsonValue; readonly field: string; readonly prefix: string; readonly map: Mapping }
function selectList({ body, field, prefix, map }: CurrentListInput): Result<readonly SelectedItem[], ExtractionFailure> {
  const values = listAt(body, [field]);
  if (!values.ok) return values;
  const result: SelectedItem[] = [];
  for (const [index, value] of values.value.entries()) {
    const selected = map(value, `${prefix}/${field}/${index}`);
    if (!selected.ok) return selected;
    result.push(selected.value);
  }
  return ok(result);
}
interface NestedSelection { readonly value: JsonValue; readonly path: string; readonly parent: JsonValue; readonly parent_path: string }
interface NestedListInput { readonly body: JsonValue; readonly outer: string; readonly inner: string; readonly map: (selection: NestedSelection) => Result<SelectedItem, ExtractionFailure> }
function nestedList({ body, outer, inner, map }: NestedListInput) {
  const parents = listAt(body, [outer]);
  if (!parents.ok) return parents;
  const result: SelectedItem[] = [];
  for (const [index, parent] of parents.value.entries()) {
    const parentPath = `/${outer}/${index}`;
    const values = selectList({ body: parent, field: inner, prefix: parentPath, map: (value, path) => map({ value, path, parent, parent_path: parentPath }) });
    if (!values.ok) return values;
    result.push(...values.value);
  }
  return ok(result);
}
interface CurrentItemInput { readonly kind: string; readonly selector: string; readonly path: string; readonly value: JsonValue; readonly id: string; readonly scope: string | null; readonly links?: SelectedItem["links"] }
function item({ kind, selector, path, value, id, scope, links = [] }: CurrentItemInput): SelectedItem {
  return { item_kind: kind, item_selector: selector, item_id_or_path: path, item_scope: scope, producer_local_id: id, selected_value: value, path, links };
}
interface CurrentDefinitionInput { readonly artifact_kind: string; readonly item_kind: string; readonly item_selector: string; readonly select: Selection }
export function currentDefinitions(schema_version: string, logical_scope: string): readonly ExtractorDefinition[] {
  const define = ({ artifact_kind, item_kind, item_selector, select }: CurrentDefinitionInput): ExtractorDefinition => ({
    artifact_kind, schema_version, extractor_id: `canonical.${artifact_kind}.${item_kind}`, extractor_version: "1", item_kind, item_selector, select,
  });
  return [
    define({ artifact_kind: "analysis", item_kind: "finding", item_selector: "/requirements/*/findings/*", select: (body) => nestedList({ body, outer: "requirements", inner: "findings", map: ({ value, path, parent, parent_path: parentPath }) => {
      const requirement = requiredId(parent, parentPath), finding = requiredId(value, path);
      if (!requirement.ok) return requirement;
      if (!finding.ok) return finding;
      return ok(item({ kind: "finding", selector: "/requirements/*/findings/*", path, value, id: finding.value, scope: null, links: [{
        target: "logical_item", type: "addresses", target_scope: logical_scope, target_local_id: requirement.value, evidence_ref: `${parentPath}/id`,
      }] }));
    } }) }),
    define({ artifact_kind: "spec", item_kind: "requirement", item_selector: "/requirements/*", select: (body) => selectList({ body, field: "requirements", prefix: "", map: (value, path) => {
      const id = requiredId(value, path);
      if (!id.ok) return id;
      const findings = idList(value, "analysis_finding_ids", path);
      if (!findings.ok) return findings;
      return ok(item({ kind: "requirement", selector: "/requirements/*", path, value, id: id.value, scope: logical_scope, links: findings.value.map((finding, index) => ({
        target: "occurrence", type: "derived_from", target_artifact_kind: "analysis", target_item_kind: "finding", target_scope: null,
        recorded_revisions_field: "analysis_revision_ids", target_local_id: finding, evidence_ref: `${path}/analysis_finding_ids/${index}`,
      })) }));
    } }) }),
    define({ artifact_kind: "plan", item_kind: "allocation", item_selector: "/cohorts/*/allocations/*", select: (body) => nestedList({ body, outer: "cohorts", inner: "allocations", map: ({ value, path }) => {
      const fields = objectAt(value, path);
      if (!fields.ok) return fields;
      const id = fields.value.requirement_id;
      return typeof id === "string" && id.length > 0
        ? ok(item({ kind: "allocation", selector: "/cohorts/*/allocations/*", path, value, id, scope: logical_scope }))
        : err({ operation: "select_items", entity_id: `${path}/requirement_id`, detail: "missing requirement id" });
    } }) }),
    define({ artifact_kind: "brief", item_kind: "build_item", item_selector: "/build_items/*", select: (body) => selectList({ body, field: "build_items", prefix: "", map: (value, path) => {
      const id = requiredId(value, path), cohort = objectAt(body, "/");
      if (!id.ok) return id;
      if (!cohort.ok) return cohort;
      if (typeof cohort.value.cohort_id !== "string") return err({ operation: "select_items", entity_id: "/cohort_id", detail: "missing cohort id" });
      const requirements = idList(value, "requirement_ids", path);
      if (!requirements.ok) return requirements;
      const links: LogicalItemLink[] = requirements.value.map((requirement, index) => ({ target: "logical_item", type: "addresses",
        target_scope: logical_scope, target_local_id: requirement, evidence_ref: `${path}/requirement_ids/${index}` }));
      return ok(item({ kind: "build_item", selector: "/build_items/*", path, value, id: id.value, scope: `cohort/${cohort.value.cohort_id}/build_item`, links }));
    } }) }),
  ];
}
export function currentItemFields(item_kind: string): readonly string[] {
  switch (item_kind) {
    case "finding": return ["/id", "/severity", "/observation", "/evidence", "/expected_change_locations", "/resolution"];
    case "requirement": return ["/id", "/text", "/acceptance_conditions", "/source_refs", "/analysis_finding_ids"];
    case "allocation": return ["/requirement_id", "/contribution"];
    case "build_item": return ["/id", "/requirement_ids", "/instructions", "/verification"];
    default: return [];
  }
}
