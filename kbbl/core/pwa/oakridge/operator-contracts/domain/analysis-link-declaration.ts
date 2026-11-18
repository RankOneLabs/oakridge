// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

export interface OperatorAnalysisLinkEntry {
  /** Legacy contracts only: current contracts derive finding links structurally. */
  readonly source_revision_id: string;
  readonly item_path: string;
  readonly task_ids: readonly string[];
}
