// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationJsonValue } from "../domain/primitives";
import type { ObservationConfigurationStoreError } from "../grading/configuration-store";
import type { ObservationRegisteredSelector } from "../grading/configuration";
import type { ObservationPublicationError } from "../grading/publication";
import type { ObservationErrorBody } from "./errors";
import type { ObservationGraderCapability } from "./health";

export interface ObservationGradingCatalogue {
  readonly selectors: readonly ObservationRegisteredSelector[];
  readonly evidence_capabilities: readonly ObservationEvidenceCapabilityRead[];
  readonly runners: readonly string[];
}

export interface ObservationGradingRuntimeRead {
  readonly version: number | null;
  readonly hash: string | null;
  readonly graders: ObservationGraderCapability;
  readonly applied_at: string;
  readonly last_failure: ObservationPublicationError | null;
}

export interface ObservationVersionListing {
  readonly versions: readonly ObservationVersionSummary[];
  readonly damaged_versions: readonly ObservationDamagedVersion[];
  /** Includes damaged history so clients can publish with the actual latest version precondition. */
  readonly latest_version: number | null;
}

export interface ObservationConfigurationErrorBody extends ObservationErrorBody {
  readonly error: ObservationErrorBody["error"] & (ObservationPublicationError | ObservationConfigurationStoreError);
}

export interface ObservationEvidenceCapabilityRead {
  readonly name: string;
  readonly subject_requirements: { readonly fields: readonly string[]; readonly task_subject: boolean };
  readonly params_schema: ObservationJsonValue;
}

export interface ObservationVersionSummary { readonly version: number; readonly hash: string; readonly published_at: string; readonly definition_count: number }

export interface ObservationDamagedVersion { readonly version: number; readonly error: ObservationConfigurationStoreError }
