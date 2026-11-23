import type { ArtifactKey } from "./artifact-versions";
import { ok, type JsonValue, type Result } from "../../domain/primitives";
import { listAt, type ExtractionFailure, type ExtractorDefinition, type LinkReference, type SelectedItem } from "../../projection/extractor";

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
export function pathItem(item_kind: string, item_selector: string, path: string, selected_value: JsonValue,
  links: readonly LinkReference[] = [], producer_local_id: string | null = null): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: path, item_scope: null, producer_local_id,
    selected_value, path, links };
}
export function taskItem(item_kind: string, item_selector: string, path: string, task_id: string, selected_value: JsonValue,
  links: readonly LinkReference[] = [], task_kind = "requirement"): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: path, item_scope: TASK_SCOPE, producer_local_id: task_id,
    logical_item: { scope: TASK_SCOPE, task_kind, producer_local_id: task_id },
    selected_value, path, links };
}
export function idItem(item_kind: string, item_selector: string, path: string, scope: string,
  localId: string, selected_value: JsonValue, links: readonly LinkReference[] = []): SelectedItem {
  return { item_kind, item_selector, item_id_or_path: `${scope}:${localId}`, item_scope: scope,
    producer_local_id: localId, selected_value, path, links };
}
export function mapped(values: readonly JsonValue[], prefix: string, map: Mapping): Result<readonly SelectedItem[], ExtractionFailure> {
  const items: SelectedItem[] = [];
  for (const [index, value] of values.entries()) {
    const item = map(value, `${prefix}/${index}`);
    if (!item.ok) return item;
    items.push(item.value);
  }
  return ok(items);
}
export function topList(field: string, map: Mapping): (body: JsonValue) => Result<readonly SelectedItem[], ExtractionFailure> {
  return (body) => {
    const values = listAt(body, [field]);
    return values.ok ? mapped(values.value, `/${field}`, map) : values;
  };
}
export type Extractor = Omit<ExtractorDefinition, "artifact_kind" | "schema_version">;
export interface Registration { readonly key: ArtifactKey; readonly extractors: readonly ExtractorDefinition[] }
export function definition(extractor_id: string, item_kind: string, item_selector: string, select: ExtractorDefinition["select"]): Extractor {
  return { extractor_id, extractor_version: VERSION, item_kind, item_selector, select };
}
export function register(key: ArtifactKey, extractors: readonly Extractor[]): Registration {
  return { key, extractors: extractors.map((extractor) => ({ ...extractor, artifact_kind: key.artifact, schema_version: key.schema_version })) };
}
