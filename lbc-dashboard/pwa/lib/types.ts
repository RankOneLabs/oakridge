/**
 * Shared types between API responses and components. Mirrors the
 * shapes returned by lbc-dashboard's Hono backend (server.ts +
 * src/store.ts). Keep in sync with the backend; no codegen yet.
 */

export interface CellEvent {
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export interface CellSummary {
  cell_id: string;
  run_ts: string;
  target_name: string;
  condition_name: string;
  cell_dir: string;
  status: "active" | "ended";
  last_activity_ms: number;
  event_count: number;
}

export interface CellDetail extends CellSummary {
  events: CellEvent[];
  artifact_filename: string | null;
  commit_count: number;
}

export interface CommitSnapshot {
  index: number;
  filename: string;
  content: string;
}

export interface EvalScore {
  dimension: string;
  value: number;
  source: string;
}

export type Tab = "events" | "artifact" | "commits" | "scores";
