// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationConfigurationIssue } from "./configuration";

export type ObservationPublicationOutcome = ObservationPublicationMetadata & (
  | { readonly outcome: "published" } | { readonly outcome: "unchanged" } | { readonly outcome: "reapplied" }
);

export type ObservationPublicationError = ObservationPublicationErrorContext & (
  | { readonly kind: "invalid_configuration"; readonly issues: readonly ObservationConfigurationIssue[] }
  | { readonly kind: "draft_conflict"; readonly current_digest: string | null }
  | { readonly kind: "version_conflict"; readonly current_latest_version: number | null }
  | { readonly kind: "unconfigured_credential"; readonly restart_required: true }
  | { readonly kind: "registration_failed" | "persistence_failed" | "runtime_apply_failed" }
);

export interface ObservationPublicationMetadata {
  readonly version: number;
  readonly hash: string;
  readonly published_at: string;
}

export interface ObservationPublicationErrorContext { readonly operation: "grading_publication"; readonly entity_id: string; readonly detail: string }
