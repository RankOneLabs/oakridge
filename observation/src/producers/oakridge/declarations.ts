import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import type { DeclarationDecodeError } from "../../ports/producer-profile";
import type { RelationDeclaration } from "../../projection/relations";
import { TASK_SCOPE } from "./catalogue";

/**
 * Oakridge's analysis-link declaration, as its writer journaled it: one exact approved tasks revision
 * and explicit entries addressing original findings. Each entry's task id is one `assesses` edge to
 * that run's logical task. Mirrors oakridge-dbos/src/domain/analysis-link-declaration.ts.
 */
export interface AnalysisLinkEntry { readonly source_revision_id: string; readonly item_path: string; readonly task_ids: readonly string[] }
export interface AnalysisLinkDeclaration { readonly run_id: string; readonly tasks_revision_id: string; readonly entries: readonly AnalysisLinkEntry[] }

const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const record = (value: unknown): value is { readonly [key: string]: unknown } =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isEntry = (value: unknown): value is AnalysisLinkEntry => record(value) && nonempty(value.source_revision_id) && nonempty(value.item_path)
  && Array.isArray(value.task_ids) && value.task_ids.every(nonempty);
const isDeclaration = (value: unknown): value is AnalysisLinkDeclaration => record(value) && nonempty(value.run_id)
  && nonempty(value.tasks_revision_id) && Array.isArray(value.entries) && value.entries.every(isEntry);

/** The relation id is derived from this reference, so the same statement against the same approved
 * revision is one relation however often it is delivered or declared. */
const declarationReference = (tasks_revision_id: string, task_id: string): string => `analysis_link_declaration:${tasks_revision_id}:${task_id}`;

export function declaredAnalysisLinks(declaration: JsonValue, run_id: string): Result<readonly RelationDeclaration[], DeclarationDecodeError> {
  if (!isDeclaration(declaration)) return err({ operation: "decode_relation_declaration", entity_id: run_id, detail: "invalid analysis link declaration" });
  if (declaration.run_id !== run_id) return err({ operation: "decode_relation_declaration", entity_id: run_id, detail: `declaration names run ${declaration.run_id}` });
  return ok(declaration.entries.flatMap(({ source_revision_id, item_path, task_ids }) => task_ids.map((task_id): RelationDeclaration => ({
    run_id, source_revision_id, item_path, link: { target: "logical_item", type: "assesses", target_scope: TASK_SCOPE, target_local_id: task_id,
      evidence_ref: declarationReference(declaration.tasks_revision_id, task_id) } }))));
}
