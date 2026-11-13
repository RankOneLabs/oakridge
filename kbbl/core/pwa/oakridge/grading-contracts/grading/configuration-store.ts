// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { ObservationDraftConfiguration } from "./configuration";

export interface ObservationStoredDraft { readonly document: ObservationDraftConfiguration; readonly digest: string }

export type ObservationConfigurationStoreError = ObservationStoreErrorContext & (
  | { readonly kind: "draft_conflict"; readonly current_digest: string | null }
  | { readonly kind: "io" | "invalid_document" | "invalid_version" }
);

export interface ObservationStoreErrorContext { readonly operation: "grading_config_store"; readonly entity_id: string; readonly detail: string; readonly version?: number; readonly hash?: string | null }
