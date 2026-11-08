// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorArtifactRevisionView, OperatorRevisionDecision } from "./unit-view";

export interface OperatorArtifactDetail {
  readonly run_id: string;
  readonly unit_id: string;
  readonly artifact_key: string;
  readonly schema: string;
  readonly is_reviewable: boolean;
  readonly is_editable: boolean;
  /** Of the latest revision: its latest decision's effect, or draft while it has none. */
  readonly status: OperatorArtifactRevisionStatus;
  readonly revisions: readonly OperatorArtifactRevisionView[];
  readonly decisions: readonly OperatorRevisionDecision[];
  /** The launch spec, retained for comparing a published revised spec. */
  readonly original_spec: string | null;
}

export type OperatorArtifactRevisionStatus = "draft" | "approved" | "changes_requested";
