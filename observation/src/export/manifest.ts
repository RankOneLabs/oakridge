import { canonicalDigest } from "../canonical/canonical-json";
import type { CanonicalDigest, GradeObservationId, ItemOccurrenceId, EvidenceSetId, ArtifactRevisionId } from "../domain/identity";
import type { Result } from "../domain/primitives";
import { ok } from "../domain/primitives";
import type { CanonicalizationError } from "../domain/errors";
import type { JsonValue } from "../domain/primitives";

export type CandidateDisposition =
  | { readonly disposition: "included"; readonly reason: string }
  | { readonly disposition: "excluded"; readonly reason: string };

export interface RedactionReason { readonly path: string; readonly reason: "raw_build_output" | "raw_test_output" | "repository_content" | "unclassified_content" }
export interface RedactionPolicy {
  readonly target_name: string;
  readonly allow_raw_build_output: boolean;
  readonly allow_raw_test_output: boolean;
  readonly allow_repository_content: boolean;
}
export type ExportMembership = {
  readonly candidate_id: CanonicalDigest;
  readonly occurrence_id: ItemOccurrenceId;
  readonly revision_id: ArtifactRevisionId;
  readonly revision_digest: CanonicalDigest;
  readonly evidence_set_id: EvidenceSetId | null;
  readonly evidence_set_digest: CanonicalDigest | null;
  readonly observation_id: GradeObservationId | null;
  readonly redaction_reasons: readonly RedactionReason[];
} & CandidateDisposition;
export interface ExportFileHashes { readonly "candidates.jsonl": string }
export interface ExportManifest {
  readonly producer: string;
  readonly namespace: string;
  readonly manifest_id: string;
  readonly frozen_at: string;
  readonly membership_digest: CanonicalDigest;
  readonly format_version: "assay-jsonl/v1";
  readonly redaction_policy: RedactionPolicy;
  readonly file_hashes: ExportFileHashes;
  readonly membership: readonly ExportMembership[];
}
export interface ExportRecord {
  readonly candidate_id: CanonicalDigest;
  readonly source_revision: { readonly revision_id: string; readonly artifact_kind: string; readonly body_digest: string; readonly body: JsonValue };
  readonly occurrence: { readonly occurrence_id: string; readonly revision_id: string; readonly selected_value: JsonValue };
  readonly evidence_set: { readonly evidence_set_id: string; readonly evidence_refs: JsonValue;
    readonly is_incomplete: boolean; readonly incompleteness_reason: string | null };
  readonly observation: { readonly observation_id: string; readonly subject_occurrence_id: string;
    readonly evidence_set_id: string; readonly answer_payload: JsonValue };
  readonly execution: { readonly execution_id: string; readonly question_id: string; readonly evaluator_definition_id: string };
  readonly evaluator: { readonly evaluator_definition_id: string; readonly kind: string; readonly identity_digest: string };
  readonly question: { readonly question_id: string; readonly question_version: string; readonly input_recipe: JsonValue;
    readonly response_kind: string };
}
export interface ExportInput {
  readonly manifest: ExportManifest;
  readonly records: readonly ExportRecord[];
  readonly directory: string;
}
export interface ExportOutput {
  readonly directory: string;
  readonly manifest_path: string;
  readonly data_path: string;
  readonly manifest: ExportManifest;
}
export interface ExperimentExporter { export(input: ExportInput): Promise<ExportOutput> }

/** Digest sorted membership, independent of time, id, and file serialization. */
export function membershipDigest(membership: readonly ExportMembership[]): Result<CanonicalDigest, CanonicalizationError> {
  return canonicalDigest([...membership].sort((a, b) => a.candidate_id.localeCompare(b.candidate_id)));
}

export function makeManifest(input: Omit<ExportManifest, "membership_digest">): Result<ExportManifest, CanonicalizationError> {
  const digest = membershipDigest(input.membership);
  return digest.ok ? ok({ ...input, membership_digest: digest.value }) : digest;
}
