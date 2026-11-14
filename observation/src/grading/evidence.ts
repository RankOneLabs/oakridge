import { RELATION_SEMANTICS } from "../projection/relations";
import type { RelationType } from "../projection/extractor";
import { z } from "zod";
import { canonicalDigest } from "canonical-json";
import type { ArtifactRevisionId, EvaluatorDefinitionId, EvidenceSetId, ItemOccurrenceId, LogicalItemId, QuestionId, RunId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { CapturedSources } from "../ports/artifact-source";
import type { EvidenceCapabilities, EvidenceCapabilityReference, EvidenceCollector } from "../ports/producer-profile";
import type { QuestionKey } from "./question";

/** A line or inclusive line range cited within a repository file. */
export interface LineRange { readonly start: number; readonly end: number }

interface ReferenceFields {
  /** The label a grader sees this content under; unique within one evidence set. */
  readonly ref: string;
  readonly content: JsonValue;
}
/** Content copied from an exact captured revision, or from one item path within it. */
export interface RevisionEvidence extends ReferenceFields {
  readonly source: "revision";
  readonly revision_id: ArtifactRevisionId;
  readonly item_path: string | null;
}
/** A field of the run's captured launch input. */
export interface RunInputEvidence extends ReferenceFields {
  readonly source: "run_input";
  readonly run_id: RunId;
  readonly input_path: string;
}
/** A file read at an exact commit. A file missing at that commit is evidence, not a failed read. A binary
 * file is present at that commit with null content: its bytes are not copied, only its size. */
export interface RepositoryEvidence extends ReferenceFields {
  readonly source: "repository";
  readonly repository_key: string;
  readonly commit_sha: string;
  readonly path: string;
  readonly line_range: LineRange | null;
  readonly is_absent: boolean;
  readonly is_binary: boolean;
  /** The size in bytes of a binary file; null for a text or absent file. */
  readonly byte_size: number | null;
}
/** Text the producer's agent reported, at the exact revision and item path it was reported in.
 * It is passed through and never independently verified. */
export interface ReportedEvidence extends ReferenceFields {
  readonly source: "reported";
  readonly reported_by: "agent";
  readonly revision_id: ArtifactRevisionId;
  readonly item_path: string;
}
export type EvidenceReference = RevisionEvidence | RunInputEvidence | RepositoryEvidence | ReportedEvidence;

type JsonObject = { readonly [key: string]: JsonValue };
/** One reference as every provider is shown it, under its `ref`: the content together with its
 * source and exact provenance. A file missing at its commit says `is_absent: true`, and a binary
 * file `is_binary: true` with its size, rather than either arriving as a bare null. */
export function providerEvidence(reference: EvidenceReference): JsonObject {
  switch (reference.source) {
    case "revision": return { source: reference.source, revision_id: reference.revision_id, item_path: reference.item_path,
      content: reference.content };
    case "run_input": return { source: reference.source, run_id: reference.run_id, input_path: reference.input_path,
      content: reference.content };
    case "repository": return { source: reference.source, repository_key: reference.repository_key, commit_sha: reference.commit_sha,
      path: reference.path, line_range: reference.line_range ? { start: reference.line_range.start, end: reference.line_range.end } : null,
      is_absent: reference.is_absent, is_binary: reference.is_binary, byte_size: reference.byte_size, content: reference.content };
    case "reported": return { source: reference.source, reported_by: reference.reported_by, revision_id: reference.revision_id,
      item_path: reference.item_path, content: reference.content };
  }
}

export type QuestionScope = { readonly scope: "per_item" } | { readonly scope: "per_task"; readonly task_ids: string } | { readonly scope: "per_task"; readonly task_source: "resolved_assesses" };
/** The identity of a captured item that a question targets. Mirrors the artifact_kind, item_selector
 * and item_kind columns of observation.item_occurrence. */
export interface CaptureTarget {
  readonly artifact_kind: string;
  readonly item_selector: string;
  readonly item_kind: string;
}
/** One question and the full evaluator set an occurrence of its declared target is pinned to when captured. */
export type CapturePin = QuestionKey & QuestionScope & CaptureTarget & {
  readonly evaluator_definition_ids: readonly EvaluatorDefinitionId[];
  readonly collection_plan?: EvidencePlan;
}
/** A pin applies only to an occurrence of its declared artifact, selector and item kind. One item kind
 * can be selected from several artifacts, so item kind alone does not identify a target. */
export const isPinTarget = (pin: CaptureTarget, occurrence: CaptureTarget): boolean =>
  pin.artifact_kind === occurrence.artifact_kind && pin.item_selector === occurrence.item_selector
  && pin.item_kind === occurrence.item_kind;
/** The configuration in force when an occurrence is captured. Later edits reach later captures. */
export interface CaptureConfiguration { readonly pins: readonly CapturePin[] }
export const NO_CAPTURE_PINS: CaptureConfiguration = { pins: [] };

/** Why one question cannot be collected yet. The question is retried when its input arrives. */
export interface NotReadyReason {
  readonly code: string;
  readonly detail: string;
}
export const COLLECTION_PENDING: NotReadyReason = { code: "collection_pending", detail: "evidence has not been collected yet" };

export type EvidenceReadiness =
  | { readonly state: "not_ready"; readonly reason: NotReadyReason }
  | { readonly state: "ready"; readonly references: readonly EvidenceReference[]; readonly ready_at: Date };

/** Mirrors observation.evidence_set: the capture pin, its readiness and its frozen references. */
export interface EvidenceSet extends QuestionKey {
  readonly evidence_set_id: EvidenceSetId;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly task_id: LogicalItemId | null;
  readonly pinned_evaluator_definition_ids: readonly EvaluatorDefinitionId[];
  readonly readiness: EvidenceReadiness;
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}
/** The evidence an evaluator is given. Only ready evidence reaches a grader. */
export interface ReadyEvidence {
  readonly evidence_set_id: EvidenceSetId;
  readonly references: readonly EvidenceReference[];
  readonly is_incomplete: boolean;
  readonly incompleteness_reason: string | null;
}

export interface EvidenceIdError { readonly operation: "evidence_set_id"; readonly entity_id: string; readonly detail: string }
/** A collector addresses the task as well as the pinned question. */
export interface SubjectQuestion extends QuestionKey { readonly task_id: LogicalItemId | null }
/** Resolved relation rows supply task identity; the configured pointer bounds their authority. */
export interface SubjectRelation {
  readonly source_occurrence_id?: string | null;
  readonly target_occurrence_id?: string | null;
  readonly type: string;
  readonly target_logical_item_id: string | null;
  readonly unresolved_target_ref: string | null;
  readonly evidence_ref: string;
}
export interface SubjectOccurrence { readonly occurrence_id: ItemOccurrenceId; readonly json_pointer: string; readonly selected_value: JsonValue }
export interface SubjectGeneration {
  readonly occurrence: SubjectOccurrence;
  readonly scope: QuestionScope;
  readonly relations: readonly SubjectRelation[];
}
export interface GradingSubject { readonly subject_occurrence_id: ItemOccurrenceId; readonly task_id: LogicalItemId | null }
/** Empty declared ids create one task-less subject; otherwise only resolved assesses edges create subjects. */
export function gradingSubjects({ occurrence, scope, relations }: SubjectGeneration): readonly GradingSubject[] {
  const subject_occurrence_id = occurrence.occurrence_id;
  if (scope.scope === "per_item") return [{ subject_occurrence_id, task_id: null }];
  if ("task_source" in scope) {
    const declaredSubjects = valueAtPointer(occurrence.selected_value, "/subjects");
    const subjects = declaredSubjects === undefined ? valueAtPointer(occurrence.selected_value, "/task_ids") : declaredSubjects;
    if (Array.isArray(subjects) && subjects.length === 0) return [{ subject_occurrence_id, task_id: null }];
    const direct = relations.filter((edge) => (edge.source_occurrence_id === undefined || edge.source_occurrence_id === subject_occurrence_id)
      && edge.type === "assesses" && edge.unresolved_target_ref === null);
    const targets = new Set(direct.flatMap((edge) => edge.target_occurrence_id ? [edge.target_occurrence_id] : []));
    const tasks = [...direct, ...relations.filter((edge) => edge.source_occurrence_id && targets.has(edge.source_occurrence_id)
      && edge.type === "addresses" && edge.unresolved_target_ref === null)];
    return [...new Set(tasks.flatMap((edge) => edge.target_logical_item_id ? [edge.target_logical_item_id as LogicalItemId] : []))]
      .sort().map((task_id) => ({ subject_occurrence_id, task_id }));
  }
  const ids = valueAtPointer(occurrence.selected_value, scope.task_ids);
  if (Array.isArray(ids) && ids.length === 0) return [{ subject_occurrence_id, task_id: null }];
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) return [];
  const prefix = `${occurrence.json_pointer}${scope.task_ids}/`;
  const tasks = relations.filter((relation) => (relation.source_occurrence_id === undefined || relation.source_occurrence_id === subject_occurrence_id)
    && RELATION_SEMANTICS[relation.type as RelationType]?.establishes_task_association && relation.unresolved_target_ref === null
    && relation.target_logical_item_id !== null && ids.some((_, index) => relation.evidence_ref === `${prefix}${index}`));
  return [...new Set(tasks.map((relation) => relation.target_logical_item_id as LogicalItemId))]
    .sort().map((task_id) => ({ subject_occurrence_id, task_id }));
}
/** The subject and question fields of the evidence_set identity key. */
export interface EvidenceSetIdInput extends GradingSubject { readonly question: QuestionKey }
/** One evidence set per occurrence, task and question version, whatever its content becomes. */
export function evidenceSetId({ subject_occurrence_id, question, task_id }: EvidenceSetIdInput): Result<EvidenceSetId, EvidenceIdError> {
  const digest = canonicalDigest([subject_occurrence_id, task_id, question.question_id, question.question_version]);
  return digest.ok ? ok(digest.value as unknown as EvidenceSetId)
    : err({ operation: "evidence_set_id", entity_id: subject_occurrence_id, detail: digest.error.detail });
}

/** RFC 6901 pointers work for both selected item fields and captured source lists. */
export function valueAtPointer(value: JsonValue, pointer: string): JsonValue | undefined {
  if (pointer === "") return value;
  if (!pointer.startsWith("/") || /~(?![01])/.test(pointer)) return undefined;
  let current: JsonValue | undefined = value;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object") return undefined;
    current = Array.isArray(current) ? (/^(0|[1-9][0-9]*)$/.test(key) ? current[Number(key)] : undefined) : (current as { readonly [key: string]: JsonValue })[key];
  }
  return current;
}

/** Promise memoization includes missing reads: all entries see one captured context per collection. */
function memoizedRead<Input, Output>(read: (input: Input) => Promise<Output>, key: (input: Input) => string): (input: Input) => Promise<Output> {
  const cache = new Map<string, Promise<Output>>();
  return (input) => {
    const identity = key(input);
    const existing = cache.get(identity);
    if (existing) return existing;
    const pending = read(input);
    cache.set(identity, pending);
    return pending;
  };
}
export function memoizedSources(sources: CapturedSources): CapturedSources {
  const input = memoizedRead(() => sources.readRunInput(), () => "input");
  const revisionAt = memoizedRead((request: { readonly kind: string; readonly revision_id: import("../domain/identity").ArtifactRevisionId }) =>
    sources.readRevisionAt(request.kind, request.revision_id), (request) => JSON.stringify(request));
  return { repository: sources.repository, readRunInput: () => input(undefined),
    readRevision: memoizedRead((id: string) => sources.readRevision(id), (id) => id),
    readRevisionAt: (kind, revision_id) => revisionAt({ kind, revision_id }),
    readLogicalItemAt: memoizedRead((request: import("../ports/artifact-source").LogicalItemContextRequest) => sources.readLogicalItemAt(request), JSON.stringify),
    readLinkedItems: memoizedRead((id: ItemOccurrenceId) => sources.readLinkedItems(id), (id) => id) };
}
export interface EvidencePlan extends QuestionKey { readonly evidence: readonly EvidenceCapabilityReference[] }
export const capabilityReferenceSchema = z.union([z.string().min(1), z.strictObject({ capability: z.string().min(1), params: z.json().optional() })]);
const evidencePlanSchema = z.strictObject({ question_id: z.string().min(1), question_version: z.string().min(1), evidence: z.array(capabilityReferenceSchema) });
export interface EvidencePlanError { readonly operation: "decode_evidence_plan"; readonly entity_id: string; readonly detail: string }
/** JSONB plans mirror capture pins, including the question key they are immutable under. */
export function decodeEvidencePlan(raw: JsonValue): Result<EvidencePlan, EvidencePlanError> {
  const parsed = evidencePlanSchema.safeParse(raw);
  return parsed.success ? ok({ ...parsed.data, question_id: parsed.data.question_id as QuestionId })
    : err({ operation: "decode_evidence_plan", entity_id: "collection_plan", detail: parsed.error.message });
}
/** A question id only selects its declared plan; no producer code dispatches on it. */
export function createCapabilityCollector(plans: readonly EvidencePlan[], capabilities: EvidenceCapabilities): EvidenceCollector {
  return { async collect(artifact, question, sources) {
    const plan = question.collection_plan ?? plans.find((entry) => entry.question_id === question.question_id && entry.question_version === question.question_version);
    if (!plan) return { state: "not_ready", reason: { code: "definition_unavailable", detail: "pinned definition is unavailable in this process" } };
    const context = { artifact, question, sources: memoizedSources(sources) };
    const references: EvidenceReference[] = [];
    for (const entry of plan.evidence) {
      const name = typeof entry === "string" ? entry : entry.capability;
      const capability = Object.hasOwn(capabilities, name) ? capabilities[name] : undefined;
      if (!capability) return { state: "not_ready", reason: { code: "capability_unavailable", detail: name } };
      const result = await capability.resolve(context, typeof entry === "string" ? {} : entry.params ?? {});
      if (result.state === "not_ready") return result;
      references.push(...result.references);
    }
    return { state: "ready", references };
  } };
}


export interface SubjectTaskRequest {
  readonly pinned_tasks: readonly (LogicalItemId | null)[];
  readonly scope: QuestionScope | undefined;
  readonly task_id: LogicalItemId | null;
}
/** Pinned subjects are authoritative; current configuration only describes an as-yet unpinned question. */
export function subjectTaskProblem({ pinned_tasks, scope, task_id }: SubjectTaskRequest): "task_required" | "task_not_applicable" | null {
  const has_taskless = pinned_tasks.includes(null);
  const has_tasks = pinned_tasks.some((task) => task !== null);
  if (task_id === null && !has_taskless && (has_tasks || scope?.scope === "per_task")) return "task_required";
  if (task_id !== null && !has_tasks && (has_taskless || scope?.scope === "per_item")) return "task_not_applicable";
  return null;
}
