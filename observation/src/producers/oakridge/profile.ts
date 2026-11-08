import type { ExtractionProfile, ProducerProfile, RevisionHeader, RevisionLink } from "../../ports/producer-profile";
import { oakridgeCatalogue, TASK_SCOPE } from "./catalogue";
import { declaredAnalysisLinks } from "./declarations";
import { oakridgeEvidence } from "./evidence";
import { OAKRIDGE_QUESTIONS } from "./questions";

const extraction: ExtractionProfile = {
  definitions: oakridgeCatalogue,
  /** An assessment's subject is the build result it assessed. Integration assessments name none. */
  revisionLink(revision: RevisionHeader): RevisionLink | null {
    return revision.artifact_kind === "assessment" && revision.subject_id
      ? { target_artifact_kind: "build_result", subject_revision_id: revision.subject_id } : null;
  },
  declaredRelations: declaredAnalysisLinks,
};

export const oakridgeProfile: ProducerProfile = { producer: "oakridge", extraction, questions: OAKRIDGE_QUESTIONS,
  evidence: oakridgeEvidence, composite: { logical_scope: TASK_SCOPE, relation_type: "assesses" } };
