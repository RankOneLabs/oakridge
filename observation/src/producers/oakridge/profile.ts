import type { ApplicableRepository, CompositeInputs, CompositeLogicalItem, RepositoryJudgment } from "../../grading/composite";
import type { ItemOccurrenceId } from "../../domain/identity";
import { createCapabilityCollector } from "../../grading/evidence";
import type { CompositePath, ExtractionProfile, ProducerProfile, RevisionHeader, RevisionLink } from "../../ports/producer-profile";
import { selectRegistration, OAKRIDGE_SELECTORS, TASK_SCOPE } from "./catalogue";
import { oakridgeCapabilities } from "./evidence";
import type { QuestionDefinition } from "../../grading/question";
import type { GradingRegistry } from "../../grading/configuration";

const extraction: ExtractionProfile = {
  definitions: (revision) => selectRegistration(revision)?.extractors,
  /** An assessment's subject is the build result it assessed. Integration assessments name none. */
  revisionLink(revision: RevisionHeader): RevisionLink | null {
    return revision.artifact_kind === "assessment" && revision.subject_id
      ? { target_artifact_kind: "build_result", subject_revision_id: revision.subject_id } : null;
  },
};

function repositoryApplicability(inputs: CompositeInputs, task: CompositeLogicalItem): readonly ApplicableRepository[] {
  if (task.task_kind !== "requirement") return [];
  const buildItems = new Map<ItemOccurrenceId, string>();
  const repositories = new Map<string, RepositoryJudgment[]>();
  const occurrences = new Map(inputs.occurrences.map((entry) => [entry.occurrence_id, entry]));
  const publishedAt = new Map(inputs.revisions.map((revision) => [revision.revision_id, revision.recorded_at.getTime()]));
  for (const relation of inputs.relations) {
    if (relation.type !== "addresses" || relation.target_logical_item_id !== task.logical_item_id) continue;
    const qualifier = relation.qualifier;
    if (!qualifier || typeof qualifier !== "object" || !("repository_key" in qualifier) || typeof qualifier.repository_key !== "string") continue;
    if (occurrences.get(relation.source_occurrence_id)?.item_kind !== "build_item") continue;
    buildItems.set(relation.source_occurrence_id, qualifier.repository_key);
    if (!repositories.has(qualifier.repository_key)) repositories.set(qualifier.repository_key, []);
  }
  for (const relation of inputs.relations) {
    if (relation.type !== "assesses" || relation.target_occurrence_id === null) continue;
    const key = buildItems.get(relation.target_occurrence_id);
    const assessment = occurrences.get(relation.source_occurrence_id);
    if (!key || assessment?.item_kind !== "item_assessment") continue;
    const value = assessment.selected_value;
    if (!value || typeof value !== "object" || !("status" in value)) continue;
    const status = value.status;
    if (status === "met" || status === "partial" || status === "not_met")
      repositories.get(key)?.push({ assessment_revision_id: assessment.revision_id, status });
  }
  return [...repositories].sort(([left], [right]) => left.localeCompare(right))
    .map(([repository_key, judgments]) => ({
      repository_key,
      judgments: judgments.sort((left, right) =>
        (publishedAt.get(left.assessment_revision_id) ?? 0) - (publishedAt.get(right.assessment_revision_id) ?? 0)
        || left.assessment_revision_id.localeCompare(right.assessment_revision_id)),
    }));
}

const composite: CompositePath = { logical_scope: TASK_SCOPE, repositoryApplicability };

export const oakridgeGradingRegistry: GradingRegistry = { selectors: OAKRIDGE_SELECTORS, capabilities: oakridgeCapabilities };

export const oakridgeProfile = (questions: readonly QuestionDefinition[], evidence: import("../../ports/producer-profile").EvidenceCollector = createCapabilityCollector([], oakridgeCapabilities)): ProducerProfile =>
  ({ producer: "oakridge", extraction, questions, evidence, capabilities: oakridgeCapabilities, composite });
