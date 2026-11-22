// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorArtifactRevisionView, OperatorBodyValue, OperatorRevisionDecision } from "./unit-view";

export interface OperatorArtifactDetail {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  readonly schema: string;
  readonly is_reviewable: boolean;
  /** A review of this artifact declares assessment operations. */
  readonly has_assessment_operations: boolean;
  readonly is_editable: boolean;
  /** Of the latest revision: its latest decision's effect, or draft while it has none. */
  readonly status: OperatorArtifactRevisionStatus;
  readonly revisions: readonly OperatorArtifactDetailRevision[];
  readonly decisions: readonly OperatorRevisionDecision[];
  readonly view: string | null;
  readonly producing_attempt_inputs: OperatorBodyValue | null;
}

export type OperatorArtifactRevisionStatus = "draft" | "approved" | "changes_requested";

export interface OperatorArtifactDetailRevision extends OperatorArtifactRevisionView {
  readonly producing_attempt_inputs?: OperatorBodyValue | null;
}
