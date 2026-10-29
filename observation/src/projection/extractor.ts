import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { extractionIssue, type ExtractionIssue } from "./issues";

export type RelationType = "derived_from" | "addresses" | "assesses" | "supersedes" | "split_from" | "merged_from";
export interface LinkReference {
  readonly type: RelationType;
  readonly target_artifact_kind: string;
  readonly target_item_kind: string;
  readonly target_scope: string | null;
  readonly target_local_id: string;
  readonly evidence_ref: string;
  /** A shared id links revisions only when the prior item actually exists. */
  readonly if_present?: boolean;
}
export interface SelectedItem {
  readonly item_kind: string;
  readonly item_selector: string;
  readonly item_id_or_path: string;
  readonly item_scope: string | null;
  readonly producer_local_id: string | null;
  readonly selected_value: JsonValue;
  readonly path: string;
  readonly links: readonly LinkReference[];
}
export interface ExtractionFailure { readonly operation: "select_items"; readonly entity_id: string; readonly detail: string }
export interface ExtractorDefinition {
  readonly artifact_kind: string;
  readonly schema_version: string;
  readonly extractor_id: string;
  readonly extractor_version: string;
  readonly item_kind: string;
  readonly item_selector: string;
  readonly select: (body: JsonValue) => Result<readonly SelectedItem[], ExtractionFailure>;
}
export interface ExtractionPass {
  readonly items: readonly { readonly definition: ExtractorDefinition; readonly item: SelectedItem }[];
  readonly issues: readonly ExtractionIssue[];
}

export type JsonObject = { readonly [key: string]: JsonValue };
export function objectAt(value: JsonValue, path: string): Result<JsonObject, ExtractionFailure> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? ok(value as JsonObject)
    : err({ operation: "select_items", entity_id: path, detail: "expected object" });
}
export function listAt(value: JsonValue, path: readonly string[]): Result<readonly JsonValue[], ExtractionFailure> {
  let current: JsonValue = value;
  for (const segment of path) {
    const object = objectAt(current, `/${path.join("/")}`);
    if (!object.ok) return object;
    const next = object.value[segment];
    if (next === undefined) return err({ operation: "select_items", entity_id: `/${path.join("/")}`, detail: "missing list" });
    current = next;
  }
  return Array.isArray(current) ? ok(current) : err({ operation: "select_items", entity_id: `/${path.join("/")}`, detail: "expected list" });
}
export function requiredId(value: JsonValue, path: string): Result<string, ExtractionFailure> {
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const id = object.value.id;
  return typeof id === "string" && id.length > 0 ? ok(id)
    : err({ operation: "select_items", entity_id: path, detail: "missing producer id" });
}
export function idList(value: JsonValue, field: string, path: string): Result<readonly string[], ExtractionFailure> {
  const object = objectAt(value, path);
  if (!object.ok) return object;
  const ids = object.value[field];
  return Array.isArray(ids) && ids.every((id) => typeof id === "string") ? ok(ids as readonly string[])
    : err({ operation: "select_items", entity_id: `${path}/${field}`, detail: "expected id list" });
}

export function selectRevision(body: JsonValue, revision_id: string, definitions: readonly ExtractorDefinition[]): ExtractionPass {
  const items: { definition: ExtractorDefinition; item: SelectedItem }[] = [];
  const issues: ExtractionIssue[] = [];
  for (const definition of definitions) {
    let result: Result<readonly SelectedItem[], ExtractionFailure>;
    try { result = definition.select(body); }
    catch { result = err({ operation: "select_items", entity_id: definition.item_selector, detail: "selector raised" }); }
    if (!result.ok) {
      issues.push(extractionIssue(revision_id, definition.extractor_id, definition.extractor_version,
        definition.item_selector, "extraction_failed"));
      continue;
    }
    if (result.value.length === 0) issues.push(extractionIssue(revision_id, definition.extractor_id,
      definition.extractor_version, definition.item_selector, "no_matching_items"));
    for (const item of result.value) items.push({ definition, item });
  }
  return { items, issues };
}
