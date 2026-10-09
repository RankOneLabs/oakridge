import type { CompiledBundle, DefinitionBundle } from "../core-client/generated-contracts";

/** A pinned definition as the catalog lists it (GET/POST /api/definitions). */
export interface DefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: DefinitionBundle; readonly archived_at: Date | null }
/** A run's pinned definition with its checked program (GET /api/runs/:run_id/definition). */
export interface PinnedDefinition extends DefinitionSummary { readonly checked_program: CompiledBundle }
export interface DefinitionPage { readonly items: readonly DefinitionSummary[]; readonly next_cursor: string | null }
