import type { ArtifactRevisionId, ItemOccurrenceId, LogicalItemId, RunId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { EvidenceReference, NotReadyReason } from "../grading/evidence";
import type { SubjectQuestion } from "../grading/evidence";

/** One selected item, addressed by the exact revision and path it was captured from. */
export interface SourceArtifact {
  readonly occurrence_id: ItemOccurrenceId;
  readonly run_id: RunId;
  readonly revision_id: ArtifactRevisionId;
  readonly item_path: string;
  readonly item_kind: string;
  readonly selected_value: JsonValue;
}

/** A question is ready with its references, or waits on a reason of its own. Collecting one
 * question never reports on another, so a missing input delays only the question requiring it. */
export type EvidenceCollection =
  | { readonly state: "ready"; readonly references: readonly EvidenceReference[] }
  | { readonly state: "not_ready"; readonly reason: NotReadyReason };

export interface ArtifactSource {
  read(occurrence_id: ItemOccurrenceId): Promise<SourceArtifact | null>;
  collect(artifact: SourceArtifact, question: SubjectQuestion): Promise<EvidenceCollection>;
}

export interface CapturedRevision {
  readonly brief_revision_ids?: readonly string[] | null;
  readonly stage: string;
  readonly revision_id: ArtifactRevisionId;
  readonly artifact_kind: string;
  readonly subject_id: string | null;
  readonly body: JsonValue;
}
/** An item reached through an explicit relation, with the address it was captured at. */
export interface LinkedItem {
  readonly revision_id: ArtifactRevisionId;
  readonly item_path: string;
  readonly item_kind: string;
  readonly selected_value: JsonValue;
}

export interface RepositoryFileRequest {
  readonly repository_path: string;
  readonly commit_sha: string;
  readonly path: string;
}
export type RepositoryFile =
  | { readonly state: "present"; readonly content: string }
  /** The file is in the commit but is not text, so its bytes are not copied. */
  | { readonly state: "binary"; readonly byte_size: number }
  /** The commit is readable and the file is not in it. */
  | { readonly state: "absent" }
  | { readonly state: "unavailable"; readonly detail: string };

export interface RepositoryReader {
  hasCommit(repository_path: string, commit_sha: string): Promise<boolean>;
  readFile(request: RepositoryFileRequest): Promise<RepositoryFile>;
}

/** The captured material an evidence collector may read, bounded to one tenant and run. */
export interface LogicalItemContextRequest {
  readonly logical_item_id: LogicalItemId;
  readonly subject_revision_id: ArtifactRevisionId;
  readonly artifact_kind: string;
  readonly item_kind: string;
  /** When no definition exists at the subject, use the first captured definition after it. */
  readonly allow_late_reference?: boolean;
}
export interface CapturedSources {
  readRunInput(): Promise<JsonValue | null>;
  readRevision(revision_id: string): Promise<CapturedRevision | null>;
  /** Latest captured artifact in this run at the subject revision's recorded position. Later revisions are excluded. */
  readRevisionAt(artifact_kind: string, subject_revision_id: ArtifactRevisionId): Promise<CapturedRevision | null>;
  readLogicalItemAt(request: LogicalItemContextRequest): Promise<LinkedItem | null>;
  readLinkedItems(occurrence_id: ItemOccurrenceId): Promise<readonly LinkedItem[]>;
  readonly repository: RepositoryReader;
}
