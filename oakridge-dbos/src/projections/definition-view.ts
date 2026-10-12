import type { CompiledWorkflow, Workflow } from "../core-client/core-types";

/** A pinned definition as the catalog lists it (GET/POST /api/definitions). */
export interface DefinitionSummary { readonly bundle_id: string; readonly digest: string; readonly source: Workflow; readonly archived_at: Date | null }
/** A run's pinned definition with its checked program (GET /api/runs/:run_id/definition). */
export interface PinnedDefinition extends DefinitionSummary { readonly checked_program: CompiledWorkflow }
export interface DefinitionPage { readonly items: readonly DefinitionSummary[]; readonly next_cursor: string | null }
export interface DefinitionGraphNode { readonly key: string; readonly scope: string; readonly depends_on: readonly string[] }
export interface DefinitionGraph { readonly nodes: readonly DefinitionGraphNode[]; readonly edges: readonly { readonly from: string; readonly to: string }[] }
export interface DefinitionDetail extends DefinitionSummary { readonly graph: DefinitionGraph }
