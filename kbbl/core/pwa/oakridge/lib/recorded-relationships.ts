// Relationships mirror recorded authority and observation ids. Display names never resolve a link.
import type { ArtifactId } from "../../lib/ids";
import { compositeId } from "../adapters/core";
import type { OperatorArtifactRevisionView, OperatorUnitView } from "../operator-contracts/projections/unit-view";
import type { ObservationAddressedItem, ObservationLogicalLinkRead } from "../grading-contracts/grading/item-reads";
import type { ObservationQuestionKey } from "../grading-contracts/grading/question";
import { artifactRevisionIdOf } from "./grading-ids";
import type { RunWorkspacePane } from "./run-workspace";

export interface RelationshipTarget {
  readonly run_id: string;
  readonly unit_id: string | null;
  readonly artifact_id: ArtifactId | null;
  readonly revision_id: string | null;
  readonly item_path: string | null;
  readonly subject_occurrence_id: string | null;
  readonly question: ObservationQuestionKey | null;
  readonly pane: RunWorkspacePane;
}
export type RecordedResolution =
  | { readonly state: "resolved"; readonly target: RelationshipTarget }
  | { readonly state: "unresolved" | "not_captured"; readonly target: null };
interface RecordedReference { readonly label: string; readonly raw_reference: string | null; readonly resolution: RecordedResolution }
export type RecordedLink =
  | (RecordedReference & { readonly kind: "unit_dependency" })
  | (RecordedReference & { readonly kind: "effect_input_revision" })
  | (RecordedReference & { readonly kind: "revision_predecessor" })
  | (RecordedReference & { readonly kind: "revision_subject" })
  | (RecordedReference & { readonly kind: "grading_subject" })
  | (RecordedReference & { readonly kind: "task_association" });
/** Identity columns shared by recorded revision snapshots and full artifact histories. */
export interface RecordedRevisionIdentity extends Pick<OperatorArtifactRevisionView, "id" | "run_id" | "unit_id" | "artifact_key"> {}
export interface RelationshipIndex {
  readonly run_id: string;
  readonly units: readonly OperatorUnitView[];
  readonly revisions: readonly RecordedRevisionIdentity[];
}
const absent = (raw_reference: string | null): RecordedResolution => ({ state: raw_reference === null ? "not_captured" : "unresolved", target: null });
export function selectRevisionLink(index: RelationshipIndex, reference: { readonly kind: "effect_input_revision" | "revision_predecessor" | "revision_subject"; readonly revision_id: string | null; readonly label: string }): RecordedLink {
  const revision = index.revisions.find((revision) => revision.id === reference.revision_id && revision.run_id === index.run_id);
  const artifact_id = revision ? compositeId({ kind: "artifact", runId: index.run_id, unitId: revision.unit_id, name: revision.artifact_key }) as ArtifactId : null;
  return { kind: reference.kind, label: reference.label, raw_reference: reference.revision_id,
    resolution: revision && artifact_id ? { state: "resolved", target: { run_id: index.run_id, unit_id: revision.unit_id, artifact_id,
      revision_id: revision.id, item_path: null, subject_occurrence_id: null, question: null,
      pane: { kind: "artifact", artifact_id, revision_id: revision.id, run_id: index.run_id, unit_id: revision.unit_id } } } : absent(reference.revision_id) };
}
export const selectDependencyLinks = (index: RelationshipIndex, unit: OperatorUnitView): readonly RecordedLink[] => unit.depends_on.map((unit_id) => ({
  kind: "unit_dependency", label: "Previous stage", raw_reference: unit_id,
  resolution: index.units.some((candidate) => candidate.unit_id === unit_id && candidate.run_id === index.run_id)
    ? { state: "resolved", target: { run_id: index.run_id, unit_id, artifact_id: null, revision_id: null, item_path: null, subject_occurrence_id: null, question: null,
      pane: { kind: "unit", unit_id } } } : absent(unit_id) }));

export interface RecordedArtifactLocation { readonly unit_id: string; readonly artifact_key: string }
export interface RecordedInputRevisionReference { readonly revision_id: string; readonly location: RecordedArtifactLocation | null }
interface InputReferenceFields {
  readonly revision_id?: unknown; readonly id?: unknown; readonly unit?: unknown; readonly artifact?: unknown;
  readonly unit_id?: unknown; readonly artifact_key?: unknown; readonly [field: string]: unknown;
}
/** Recognize explicit reference fields and RevisionState objects, never ids hidden in prose or names. */
export function selectInputRevisionReferences(value: unknown): readonly RecordedInputRevisionReference[] {
  if (Array.isArray(value)) return value.flatMap(selectInputRevisionReferences);
  if (value === null || typeof value !== "object") return [];
  const reference = value as InputReferenceFields;
  const revision_id = typeof reference.revision_id === "string" ? reference.revision_id
    : typeof reference.id === "string" && typeof reference.unit === "string" && typeof reference.artifact === "string" ? reference.id : null;
  if (revision_id === null) return Object.values(reference).flatMap(selectInputRevisionReferences);
  const unit_id = typeof reference.unit_id === "string" ? reference.unit_id : reference.unit;
  const artifact_key = typeof reference.artifact_key === "string" ? reference.artifact_key : reference.artifact;
  // A captured revision's body is content, not another provenance graph.
  return [{ revision_id, location: typeof unit_id === "string" && typeof artifact_key === "string" ? { unit_id, artifact_key } : null }];
}
export const selectInputRevisionIds = (value: unknown): readonly string[] => selectInputRevisionReferences(value).map((reference) => reference.revision_id);
export function selectIntentLinks(index: RelationshipIndex, unit: OperatorUnitView): readonly RecordedLink[] {
  return unit.attempts.flatMap((attempt) => {
    if (!attempt.intent) return [selectRevisionLink(index, { kind: "effect_input_revision", revision_id: null, label: `${attempt.worker} #${attempt.number}: intent not captured` })];
    const { inputs, engine_inputs } = attempt.intent;
    const ids = [...selectInputRevisionIds(inputs), ...selectInputRevisionIds(engine_inputs.previous), ...selectInputRevisionIds(engine_inputs.subject), ...engine_inputs.feedback.map((feedback) => feedback.target)];
    if (ids.length === 0) return [selectRevisionLink(index, { kind: "effect_input_revision", revision_id: null, label: `${attempt.worker} #${attempt.number}: source revision ids not captured` })];
    return [...new Set(ids)].map((revision_id) => selectRevisionLink(index, { kind: "effect_input_revision", revision_id, label: `${attempt.worker} #${attempt.number}: input revision` }));
  });
}
export const selectRevisionRelationships = (index: RelationshipIndex, revision: OperatorArtifactRevisionView): readonly RecordedLink[] => [
  selectRevisionLink(index, { kind: "revision_predecessor", revision_id: revision.predecessor_id, label: `${revision.artifact_key} v${revision.number}: predecessor` }),
  selectRevisionLink(index, { kind: "revision_subject", revision_id: revision.subject_id, label: `${revision.artifact_key} v${revision.number}: subject` }),
];
export interface GradingSubjectReference { readonly item: ObservationAddressedItem; readonly question: ObservationQuestionKey | null; readonly task_id?: import("../grading-contracts/domain/identity").ObservationLogicalItemId | null }
export function selectGradingSubjectLink(index: RelationshipIndex, { item, question, task_id }: GradingSubjectReference): RecordedLink {
  const revision = index.revisions.find((revision) => revision.id === item.source_revision_id && revision.run_id === index.run_id);
  const artifact_id = revision ? compositeId({ kind: "artifact", runId: index.run_id, unitId: revision.unit_id, name: revision.artifact_key }) as ArtifactId : null;
  return { kind: "grading_subject", label: question?.question_id ?? "Grading subject", raw_reference: item.occurrence_id,
    resolution: { state: "resolved", target: { run_id: index.run_id, unit_id: item.unit_id, artifact_id, revision_id: item.source_revision_id,
      item_path: item.item_path, subject_occurrence_id: item.occurrence_id, question,
      pane: { kind: "item", selection: { source_revision_id: artifactRevisionIdOf(item.source_revision_id), item_path: item.item_path, ...(task_id ? { task_id } : {}) },
        run_id: index.run_id, unit_id: item.unit_id, artifact_id, subject_occurrence_id: item.occurrence_id, question } } } };
}
export interface TaskAssociationReference { readonly link: ObservationLogicalLinkRead; readonly item?: ObservationAddressedItem }
export function selectTaskAssociationLink(index: Pick<RelationshipIndex, "run_id" | "revisions">, { link, item }: TaskAssociationReference): RecordedLink {
  const { run_id } = index;
  const revision = index.revisions.find((revision) => revision.id === item?.source_revision_id && revision.run_id === run_id);
  const artifact_id = revision ? compositeId({ kind: "artifact", runId: run_id, unitId: revision.unit_id, name: revision.artifact_key }) as ArtifactId : null;
  return { kind: "task_association", label: "Task association", raw_reference: link.state === "resolved" ? link.logical_item_id : link.unresolved_target_ref,
    resolution: link.state === "resolved" ? { state: "resolved", target: { run_id, unit_id: item?.unit_id ?? null, artifact_id, revision_id: item?.source_revision_id ?? null, item_path: item?.item_path ?? null,
      subject_occurrence_id: item?.occurrence_id ?? null, question: null, pane: { kind: "task", task_id: link.producer_local_id, ...(item ? { run_id, unit_id: item.unit_id, artifact_id, revision_id: item.source_revision_id, item_path: item.item_path, subject_occurrence_id: item.occurrence_id } : {}) } } } : absent(link.unresolved_target_ref) };
}

export const selectUncapturedGradingLink = (revision_id: string): RecordedLink => ({ kind: "grading_subject", label: "Grading subject not captured", raw_reference: revision_id, resolution: { state: "not_captured", target: null } });
export const selectUncapturedTaskLink = (occurrence_id: string): RecordedLink => ({ kind: "task_association", label: "Task association not captured", raw_reference: occurrence_id, resolution: { state: "not_captured", target: null } });
