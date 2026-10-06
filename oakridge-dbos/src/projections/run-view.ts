import type { RunId } from "../storage/schema-records";

export interface RunScopeSummary { readonly scope_id: string; readonly scope_key: string; readonly label: string; readonly version: number; readonly is_terminal: boolean; readonly available_commands: readonly string[] }
export interface RunView { readonly run_id: RunId; readonly definition_bundle_id: string; readonly definition_digest: string; readonly version: number; readonly cursor: readonly { readonly scope_id: string; readonly version: number }[]; readonly scopes: readonly RunScopeSummary[] }
