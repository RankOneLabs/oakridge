import type { RuntimeId } from "../runtime-interface";

export interface EnvelopeEvent {
  id: number;
  type: string;
  ts: string;
  payload: unknown;
}

export type SessionStatus = "starting" | "live" | "compacting" | "ended";

export interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SessionSnapshot {
  sid: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityTs: string;
  /** Runtime adapter id for this session (e.g. "claude-code"). */
  runtimeId: RuntimeId;
  /**
   * Runtime-internal session id (e.g. CC's session_id from system/init),
   * null until observed.
   */
  runtimeSid: string | null;
  /**
   * @deprecated Use runtimeSid. Kept for backward compat — equals runtimeSid
   * for CC sessions.
   */
  ccSid: string | null;
  parentCcSid: string | null;
  parentOakridgeSid: string | null;
  pendingCount: number;
  yoloMode: boolean;
  allowedTools: string[];
  lastResultUsage: ResultUsage | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
  projectWorkdir: string | null;
  model: string | null;
  /**
   * Model the runtime actually resolved at runtime. Seeded by system+init and
   * updated by each distinct assistant.message.model; null until first
   * observation. PWA renders `observedModel ?? model` so spawn-time
   * intent remains the fallback when the runtime hasn't reported yet.
   */
  observedModel: string | null;
  endReason: "user_closed" | "subprocess_exited" | "compacted" | null;
  successorSid: string | null;
}

export type InboxDelta =
  | { type: "session_created"; session: SessionSnapshot }
  | { type: "session_ended"; sid: string }
  | { type: "session_removed"; sid: string }
  | { type: "session_compacted"; sid: string; successor_sid: string }
  | { type: "compact_suggested"; sid: string; tokens: number; reason: string }
  | { type: "status_changed"; sid: string; status: SessionStatus }
  | { type: "pending_count_changed"; sid: string; count: number }
  | { type: "last_activity_changed"; sid: string; ts: string }
  | { type: "yolo_changed"; sid: string; yoloMode: boolean };

export type Status = "connecting" | "connected" | "disconnected";
export type Theme = "dark" | "light";
export type ResolutionMap = Map<string, "allow" | "deny">;

export interface PendingPlanCard {
  id: string;
  spec_id: string;
  status: string;
  created_at: string;
}

export interface PendingBriefCard {
  id: string;
  cohort_id: string;
  goal: string;
  status: string;
  created_at: string;
}

export interface CompactSuggestion {
  sid: string;
  tokens: number;
}

export interface InboxState {
  sessions: Map<string, SessionSnapshot>;
  /**
   * Sids the server currently has in memory (live or ended-but-lingering).
   * Differs from `sessions.keys()` because archived-only entries from the
   * /sessions?include=archived fetch aren't in memory. Used to decide whether
   * a SessionView can open /:sid/stream (in-memory) or must fall back to the
   * one-shot /:sid/events (archived on disk).
   */
  inMemorySids: Set<string>;
  inboxStatus: Status;
  /** Per-session compact suggestions keyed by sid. */
  compactSuggestions: Map<string, CompactSuggestion>;
  /** Optimistically clear the suggestion for a given sid. */
  clearCompactSuggestion: (sid: string) => void;
  /**
   * Fold a snapshot we already have in hand (e.g. the response body of
   * POST /sessions) into the inbox state so the destination view mounts
   * with the correct snapshot instead of racing the /inbox delta. Safe
   * to call before /inbox actually delivers session_created — the delta
   * just re-seats the same entry.
   */
  hydrateSession: (snapshot: SessionSnapshot) => void;
}

// Reconstructs a live partial assistant message from --include-partial-messages
// stream_event records. CC emits an Anthropic-style sequence: message_start →
// content_block_start (per block) → content_block_delta (many) →
// content_block_stop → message_delta → message_stop.
//
// Built incrementally: a useRef accumulator advances as new events append to
// the array, so a long stream stays O(N) overall instead of O(N²) (each
// useMemo run previously rescanned the entire post-`result` window). Block
// updates are immutable — `blocks.set(idx, { ...block, text: block.text + ... })`
// — so cached prior renders can't be mutated by a future delta under React
// Strict Mode or the React Compiler.
export interface InFlightAssistant {
  blocks: ContentBlock[];
  outputTokens: number | null;
  startedAt: number;
}

export interface InFlightAccum {
  blocks: Map<number, ContentBlock>;
  // Per-block-index accumulator for `input_json_delta` chunks. Anthropic
  // streams tool_use inputs as concatenated partial JSON; we buffer the
  // string and parse opportunistically so the live panel can preview the
  // call (Bash command, file path, etc.) before the turn closes.
  partialToolInputs: Map<number, string>;
  // Codex delta accumulator: item_id → accumulated text. Parallel to the
  // CC block map but keyed by item_id (string). Insertion order = render order.
  codexDeltaItems: Map<string, string>;
  outputTokens: number | null;
  startedAtMs: number | null;
  lastEventIdx: number;
  sid: string;
}

export interface PendingMessage {
  localId: number;
  text: string;
  sentAt: number;
}

export interface SessionMetrics {
  turns: number;
  totalIn: number;
  totalOut: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  totalCost: number;
  totalDur: number;
  last: {
    inT: number;
    outT: number;
    cacheRead: number;
    cacheCreate: number;
    dur: number;
    cost: number;
  } | null;
}

export type ListItem =
  | { kind: "event"; event: EnvelopeEvent }
  | { kind: "tool_batch"; events: EnvelopeEvent[]; firstId: number }
  | {
      kind: "compact";
      startEvent: EnvelopeEvent;
      doneEvent: EnvelopeEvent | null;
    };

export interface SystemStatusPayload {
  subtype?: string;
  status?: string | null;
  compact_result?: string;
}

export interface ToolUseEntry {
  id: string;
  name: string;
  input: unknown;
  eventId: number;
}
export interface ToolResultEntry {
  content: unknown;
  isError: boolean;
  eventId: number;
}

export interface CCUserPayload {
  message?: { role?: string; content?: string | ContentBlock[] };
}
export interface CCAssistantPayload {
  message?: { content?: ContentBlock[] };
}
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | {
      type: "tool_result";
      tool_use_id: string;
      // Anthropic's tool_result block technically allows structured content
      // (text blocks, image blocks) in addition to plain strings. CC's CLI
      // emits strings today but typing this as `unknown` lets the renderer
      // handle both without a future schema drift breaking the UI.
      content: unknown;
      is_error?: boolean;
    };

export interface PermissionRequestPayload {
  request_id: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
}

export interface RuntimeSessionObservedPayload {
  runtime_id?: string;
  runtime_sid?: string;
}

export interface RuntimeErrorPayload {
  message?: string;
}

// Payload emitted by the Codex adapter for streaming assistant text deltas.
// Mirrors kbbl/adapters/codex/events.ts AssistantDeltaEvent payload shape.
export interface AssistantDeltaPayload {
  type: "assistant_delta";
  threadId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface InFlightCodexAccum {
  // item_id → accumulated delta text, in insertion order
  items: Map<string, string>;
}
