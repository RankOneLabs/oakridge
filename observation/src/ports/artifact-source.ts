import type { ItemOccurrenceId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { EvidenceReference, NotReadyReason } from "../grading/evidence";
import type { QuestionKey } from "../grading/question";

/** One selected item, addressed by the exact revision and path it was captured from. */
export interface SourceArtifact {
  readonly occurrence_id: ItemOccurrenceId;
  readonly run_id: string;
  readonly revision_id: string;
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
  collect(artifact: SourceArtifact, question: QuestionKey): Promise<EvidenceCollection>;
}

export interface CapturedRevision {
  readonly revision_id: string;
  readonly artifact_kind: string;
  readonly subject_id: string | null;
  readonly body: JsonValue;
}
/** An item reached through an explicit relation, with the address it was captured at. */
export interface LinkedItem {
  readonly revision_id: string;
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
  /** The commit is readable and the file is not in it. */
  | { readonly state: "absent" }
  | { readonly state: "unavailable"; readonly detail: string };

export interface RepositoryReader {
  hasCommit(repository_path: string, commit_sha: string): Promise<boolean>;
  readFile(request: RepositoryFileRequest): Promise<RepositoryFile>;
}

/** The captured material an evidence collector may read, bounded to one tenant and run. */
export interface CapturedSources {
  readRunInput(): Promise<JsonValue | null>;
  readRevision(revision_id: string): Promise<CapturedRevision | null>;
  readLinkedItems(occurrence_id: ItemOccurrenceId): Promise<readonly LinkedItem[]>;
  readonly repository: RepositoryReader;
}
