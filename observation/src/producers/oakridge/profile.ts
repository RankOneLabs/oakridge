import type { CompositePath, ExtractionProfile, ProducerProfile, RevisionHeader, RevisionLink, StagedRevision } from "../../ports/producer-profile";
import { ASSESSMENT_FINDING_KIND, FINDING_KIND, oakridgeCatalogue, OAKRIDGE_SELECTORS, TASK_SCOPE } from "./catalogue";
import { declaredAnalysisLinks } from "./declarations";
import { oakridgeEvidence, OAKRIDGE_EVIDENCE_SOURCES, OAKRIDGE_SUPPORTED_QUESTIONS } from "./evidence";
import type { QuestionDefinition } from "../../grading/question";
import type { GradingRegistry } from "../../grading/configuration";

const extraction: ExtractionProfile = {
  definitions: oakridgeCatalogue,
  /** An assessment's subject is the build result it assessed. Integration assessments name none. */
  revisionLink(revision: RevisionHeader): RevisionLink | null {
    return revision.artifact_kind === "assessment" && revision.subject_id
      ? { target_artifact_kind: "build_result", subject_revision_id: revision.subject_id } : null;
  },
  declaredRelations: declaredAnalysisLinks,
};

const INTEGRATION_UNIT = "integration";
/** Which declared unit of the development workflow published an assessment: `<run>/<declaration>/<key>`.
 * This places a revision in a stage and is never part of any item's identity. */
function stageOf(revision: StagedRevision): string | null {
  if (revision.artifact_kind === "analysis") return "analysis";
  if (revision.artifact_kind !== "assessment") return null;
  return revision.unit_id.split("/")[1] === INTEGRATION_UNIT ? "integration" : "implementation";
}

const composite: CompositePath = { logical_scope: TASK_SCOPE, relation_type: "assesses", item_kinds: [FINDING_KIND, ASSESSMENT_FINDING_KIND], stageOf,
  /** Integration is pending until its assessment publishes, and its results are final from then on. */
  stages: [{ stage: "analysis", is_final_on_publication: false }, { stage: "implementation", is_final_on_publication: false },
    { stage: "integration", is_final_on_publication: true }] };

export const oakridgeGradingRegistry: GradingRegistry = { selectors: OAKRIDGE_SELECTORS, evidence_sources: OAKRIDGE_EVIDENCE_SOURCES,
  questions: OAKRIDGE_SUPPORTED_QUESTIONS };

export const oakridgeProfile = (questions: readonly QuestionDefinition[]): ProducerProfile =>
  ({ producer: "oakridge", extraction, questions, evidence: oakridgeEvidence, composite });
