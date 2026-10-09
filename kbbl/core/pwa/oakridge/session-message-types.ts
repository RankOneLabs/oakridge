import type { JsonValue } from "./types";

/** Mirrors the run-scoped oakridge.session_message HTTP resource. */
export interface SessionMessageParty {
  kind: "core" | "agent" | "service" | "operator";
  id: string | null;
}

interface SessionMessageRecordFields {
  id: string;
  run_id: string;
  cohort_id: string | null;
  sender: SessionMessageParty;
  recipient: SessionMessageParty;
  thread_id: string;
  message_id: string;
  artifact_thread_id: string | null;
  body: JsonValue;
  delivery_key: string;
  created_at: string;
}

/** Mirrors the backend delivery-state union and excludes impossible combinations. */
export type SessionMessageRecord =
  | (SessionMessageRecordFields & { delivery_status: "pending"; delivery_result: null; delivered_at: null })
  | (SessionMessageRecordFields & { delivery_status: "delivered"; delivery_result: { kind: "delivered" }; delivered_at: string })
  | (SessionMessageRecordFields & { delivery_status: "failed"; delivery_result: { kind: "failed"; detail: string }; delivered_at: null });

export interface PostSessionMessageRequest {
  recipient: SessionMessageParty;
  thread_id: string;
  message_id?: string;
  artifact_thread_id?: string | null;
  body: JsonValue;
}

export interface SessionMessageAccepted {
  kind: "accepted";
  message: SessionMessageRecord;
  workflow_id: string;
}

