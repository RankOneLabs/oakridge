import type { ArtifactRevision } from "../artifact-types";
import type { ObservationQuestionStatusResponse } from "../grading-contracts/storage/grading-record-store";
import type { ObservationQuestionKey } from "../grading-contracts/grading/question";
import { sameQuestion, selectItemSelection } from "./grading";

export interface ArtifactRevisionSelectionInput {
  readonly revisions: readonly ArtifactRevision[];
  readonly pinned_revision_id?: string;
  readonly selected_index: number | null;
}
export interface ArtifactRevisionSelection { readonly index: number; readonly revision: ArtifactRevision }
/** A missing pin stays missing; an explicit tab choice overrides it. */
export function selectArtifactRevision({ revisions, pinned_revision_id, selected_index }: ArtifactRevisionSelectionInput): ArtifactRevisionSelection | null {
  if (revisions.length === 0) return null;
  const index = selected_index !== null ? Math.max(0, Math.min(selected_index, revisions.length - 1))
    : pinned_revision_id === undefined ? revisions.length - 1
    : revisions.findIndex((revision) => revision.id === pinned_revision_id
      || selectItemSelection({ revision_id: revision.id }, "")?.source_revision_id === pinned_revision_id);
  const revision = revisions[index];
  return revision === undefined ? null : { index, revision };
}

export interface ItemQuestionSelectionInput {
  readonly questions: readonly ObservationQuestionStatusResponse[];
  readonly target?: ObservationQuestionKey | null;
  readonly selected_index: number | null;
}
export interface ItemQuestionSelection {
  readonly question: ObservationQuestionStatusResponse | null;
  readonly is_target_missing: boolean;
}
/** Select by the recorded id and version until the operator chooses a question. */
export function selectItemQuestion({ questions, target, selected_index }: ItemQuestionSelectionInput): ItemQuestionSelection {
  const index = selected_index !== null ? Math.max(0, Math.min(selected_index, questions.length - 1))
    : target ? questions.findIndex((question) => sameQuestion(question.question, target)) : 0;
  const question = questions[index] ?? null;
  return { question, is_target_missing: target != null && selected_index === null && question === null };
}
