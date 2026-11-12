import { createCapabilityCollector } from "../../grading/evidence";
import type { CompositePath, ExtractionProfile, ProducerProfile, RevisionHeader, RevisionLink } from "../../ports/producer-profile";
import { oakridgeCatalogue, OAKRIDGE_SELECTORS, TASK_SCOPE } from "./catalogue";
import { declaredAnalysisLinks } from "./declarations";
import { oakridgeCapabilities } from "./evidence";
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

const composite: CompositePath = { logical_scope: TASK_SCOPE };

export const oakridgeGradingRegistry: GradingRegistry = { selectors: OAKRIDGE_SELECTORS, capabilities: oakridgeCapabilities };

export const oakridgeProfile = (questions: readonly QuestionDefinition[], evidence: import("../../ports/producer-profile").EvidenceCollector = createCapabilityCollector([], oakridgeCapabilities)): ProducerProfile =>
  ({ producer: "oakridge", extraction, questions, evidence, capabilities: oakridgeCapabilities, composite });
