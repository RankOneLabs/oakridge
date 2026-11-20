import type { AcpUiEvent, TurnKey, UiAvailableCommand, UiSessionConfig, UiToolLocation } from "./types";

export type TranscriptItemId = string & { readonly __brand: "TranscriptItemId" };
export type TranscriptSeq = number & { readonly __brand: "TranscriptSeq" };
export type StreamEpoch = string & { readonly __brand: "StreamEpoch" };
/** The kbbl-issued perm-N identifier. */
export type PermissionRequestId = string & { readonly __brand: "PermissionRequestId" };

export function transcriptItemId(seq: TranscriptSeq): TranscriptItemId {
  return `item-${seq}` as TranscriptItemId;
}

export function transcriptSeq(n: number): TranscriptSeq {
  return n as TranscriptSeq;
}

export function streamEpoch(s: string): StreamEpoch {
  return s as StreamEpoch;
}

export function permissionRequestId(s: string): PermissionRequestId {
  return s as PermissionRequestId;
}

export type OpenEnum<T extends string> =
  | { readonly is_recognized: true; readonly value: T }
  | { readonly is_recognized: false; readonly raw: string };

// ACP SDK 1.4.0 vocabulary, with cancelled also recognized for tool and plan updates.
export const TOOL_STATUSES = ["pending", "in_progress", "completed", "failed", "cancelled"] as const;
export const TOOL_KINDS = ["read", "edit", "delete", "move", "search", "execute", "think", "fetch", "switch_mode", "other"] as const;
export const PLAN_ENTRY_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const;
export const PLAN_PRIORITIES = ["high", "medium", "low"] as const;
export const PERMISSION_OPTION_KINDS = ["allow_once", "allow_always", "reject_once", "reject_always"] as const;
export type ToolStatus = typeof TOOL_STATUSES[number];
export type ToolKind = typeof TOOL_KINDS[number];
export type PlanEntryStatus = typeof PLAN_ENTRY_STATUSES[number];
export type PlanPriority = typeof PLAN_PRIORITIES[number];
export type PermissionOptionKind = typeof PERMISSION_OPTION_KINDS[number];

export type ToolContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "diff"; readonly path: string; readonly old_text: string | null; readonly new_text: string }
  | { readonly type: "terminal"; readonly terminal_id: string }
  | { readonly type: "unsupported"; readonly acp_type: string };

interface ItemIdentity {
  readonly id: TranscriptItemId;
  readonly seq: TranscriptSeq;
}

interface MessageText extends ItemIdentity {
  readonly message_id: string | null;
  readonly text: string;
  readonly is_replayed: boolean;
}

export interface UserMessageItem extends MessageText {
  readonly kind: "user_message";
  readonly turn_key: TurnKey | null;
}

export interface AgentMessageItem extends MessageText {
  readonly kind: "agent_message";
  readonly is_streaming: boolean;
}

export interface ThoughtItem extends MessageText {
  readonly kind: "thought";
  readonly is_streaming: boolean;
}

export interface ToolCallItem extends ItemIdentity {
  readonly kind: "tool_call";
  readonly tool_call_id: string;
  readonly title: string;
  readonly tool_kind: OpenEnum<ToolKind>;
  readonly status: OpenEnum<ToolStatus>;
  readonly content: readonly ToolContent[];
  readonly locations: readonly UiToolLocation[];
}

export interface PlanItemEntry {
  readonly content: string;
  readonly status: OpenEnum<PlanEntryStatus>;
  readonly priority: OpenEnum<PlanPriority>;
}

export interface PlanItem extends ItemIdentity {
  readonly kind: "plan";
  readonly entries: readonly PlanItemEntry[];
}

export interface PermissionItemOption {
  readonly option_id: string;
  readonly name: string;
  readonly kind: PermissionOptionKind | null;
}

export type PermissionResolution =
  | { readonly kind: "selected"; readonly option_id: string }
  | { readonly kind: "cancelled" };

export interface PermissionItem extends ItemIdentity {
  readonly kind: "permission";
  readonly request_id: PermissionRequestId;
  readonly title: string;
  readonly options: readonly PermissionItemOption[];
  readonly resolution: PermissionResolution | null;
}

export interface TurnNoteItem extends ItemIdentity {
  readonly kind: "turn_note";
  readonly turn_key: TurnKey;
  readonly state: "cancelled" | "failed" | "unknown";
  readonly stop_reason: string | null;
  readonly detail: string | null;
}

export type TranscriptItem = UserMessageItem | AgentMessageItem | ThoughtItem | ToolCallItem | PlanItem | PermissionItem | TurnNoteItem;

export interface UiUsage {
  readonly used: number | null;
  readonly size: number | null;
  readonly cost: { readonly amount: number; readonly currency: string } | null;
}

export interface LatestAgentLine {
  readonly item_id: TranscriptItemId;
  readonly text: string;
}

export interface ActiveTool {
  readonly item_id: TranscriptItemId;
  readonly tool_call_id: string;
  readonly title: string;
  readonly tool_kind: OpenEnum<ToolKind>;
  readonly status: OpenEnum<ToolStatus>;
}

export interface PlanProgress {
  readonly total: number;
  readonly completed: number;
  readonly current_entry: string | null;
}

export interface SessionLiveState {
  readonly config_options: readonly UiSessionConfig[];
  readonly commands: readonly UiAvailableCommand[];
  readonly usage: UiUsage | null;
  readonly session_title: string | null;
  readonly active_turn: TurnKey | null;
  readonly latest_agent_line: LatestAgentLine | null;
  readonly active_tool: ActiveTool | null;
  readonly plan_progress: PlanProgress | null;
  readonly latest_plan: PlanItem | null;
  readonly open_permissions: readonly PermissionItem[];
}

export const EMPTY_SESSION_LIVE_STATE: SessionLiveState = {
  config_options: [],
  commands: [],
  usage: null,
  session_title: null,
  active_turn: null,
  latest_agent_line: null,
  active_tool: null,
  plan_progress: null,
  latest_plan: null,
  open_permissions: [],
};

export interface OpenTextRun {
  readonly item_id: TranscriptItemId;
  readonly kind: "user_message" | "agent_message" | "thought";
  readonly message_id: string | null;
}

export interface AgentLineCursor {
  readonly latest_line: string;
  readonly trailing_whitespace: string | null;
}

export interface RetainedText {
  readonly bytes: number;
  readonly ends_with_high_surrogate: boolean;
  readonly agent_line: AgentLineCursor | null;
}

export interface TranscriptBuffer {
  readonly epoch: StreamEpoch;
  readonly capacity: number;
  readonly items: readonly TranscriptItem[];
  readonly next_seq: TranscriptSeq;
  readonly is_truncated: boolean;
  readonly live_state: SessionLiveState;
  readonly open_text: OpenTextRun | null;
  readonly retained_text: Readonly<Partial<Record<TranscriptItemId, RetainedText>>>;
  readonly tool_turns: Readonly<Partial<Record<TranscriptItemId, TurnKey | null>>>;
}

export type TurnFrameState = "prompting" | "idle" | "cancelled" | "failed" | "unknown";

export type StreamFrame =
  | { readonly kind: "item_upsert"; readonly item: TranscriptItem }
  | { readonly kind: "item_text"; readonly item_id: TranscriptItemId; readonly seq: TranscriptSeq; readonly delta: string }
  | { readonly kind: "items_evicted"; readonly item_ids: readonly TranscriptItemId[]; readonly is_truncated: true }
  | { readonly kind: "session_state"; readonly state: SessionLiveState }
  | { readonly kind: "turn_state"; readonly turn_key: TurnKey; readonly state: TurnFrameState; readonly stop_reason: string | null; readonly detail: string | null };

export interface FoldResult {
  readonly buffer: TranscriptBuffer;
  readonly frames: readonly StreamFrame[];
}

export interface TranscriptSnapshot {
  readonly stream_epoch: StreamEpoch;
  readonly items: readonly TranscriptItem[];
  readonly is_truncated: boolean;
  readonly live_state: SessionLiveState;
  readonly open_text: OpenTextRun | null;
}

export interface TranscriptEmission {
  readonly event: AcpUiEvent;
  readonly frames: readonly StreamFrame[];
}
