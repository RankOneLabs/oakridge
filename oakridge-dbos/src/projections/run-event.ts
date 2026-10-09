import type { AttentionMetadata, DecisionOutcome } from "../core-client/generated-contracts";
import type { RunId, ScopeId } from "../storage/schema-records";

/** One committed transition as the operator event stream delivers it (GET /events). */
export interface RunEvent {
  readonly transition_id: string;
  readonly run_id: RunId;
  readonly scope_id: ScopeId;
  readonly scope_key: string;
  readonly decision: DecisionOutcome["kind"];
  /** Set when the scope now waits on the operator. */
  readonly attention: AttentionMetadata | null;
  readonly is_terminal: boolean;
  /** ISO-8601, as the transition log recorded it. */
  readonly occurred_at: string;
}
/** Resume position in the transition log: the last delivered transition. */
export interface RunEventCursor { readonly created_at: string; readonly id: string }

export interface TransitionEventRow {
  readonly id: string; readonly run_id: RunId; readonly scope_id: ScopeId; readonly scope_key: string;
  readonly decision: DecisionOutcome; readonly is_terminal: boolean; readonly created_at: string;
}
export function selectRunEvent(row: TransitionEventRow): RunEvent {
  return { transition_id: row.id, run_id: row.run_id, scope_id: row.scope_id, scope_key: row.scope_key, decision: row.decision.kind,
    attention: row.decision.kind === "wait" ? row.decision.attention ?? null : null, is_terminal: row.is_terminal, occurred_at: row.created_at };
}
