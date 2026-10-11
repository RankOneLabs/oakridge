import type { RunId } from "../storage/schema-records";

export interface RunScopeSummary { readonly scope_id: string; readonly scope_key: string; readonly label: string; readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }
export interface RunSummary { readonly run_id: RunId; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number;
  readonly created_at: Date; readonly archived_at: Date | null }
export interface RunView extends RunSummary {
  readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly scopes: readonly RunScopeSummary[] }
/** The run endpoint's complete projection. */
export type RunDetail = RunView;
export interface RunPage { readonly items: readonly RunView[]; readonly next_cursor: string | null }
