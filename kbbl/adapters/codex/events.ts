// Event normalization: maps Codex app-server notifications → kbbl envelope events.
// Each function returns { type: string; payload: Record<string, unknown> } or null (skip).

import type {
  ItemAgentMessageDeltaParams,
  TurnCompletedParams,
  ThreadTokenUsageUpdatedParams,
} from "./protocol/generated/types";

export interface KbblEvent {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Map item/agentMessage/delta → assistant_delta (non-persisted streaming token).
 */
export function normalizeAgentMessageDelta(
  params: ItemAgentMessageDeltaParams,
): KbblEvent {
  return {
    type: "assistant_delta",
    payload: {
      type: "assistant_delta",
      threadId: params.threadId,
      turnId: params.turnId,
      itemId: params.itemId,
      delta: params.delta,
    },
  };
}

/**
 * Map item/completed for agentMessage items → assistant event.
 * Returns null if item is not an agentMessage or has no text.
 */
export function normalizeAgentMessageCompleted(
  item: unknown,
  threadId: string,
  turnId: string,
): KbblEvent | null {
  if (
    typeof item !== "object" ||
    item === null ||
    (item as { type?: unknown }).type !== "agentMessage"
  ) {
    return null;
  }
  const msg = item as { type: string; id?: string; text?: unknown };
  return {
    type: "assistant",
    payload: {
      type: "assistant",
      threadId,
      turnId,
      message: {
        role: "assistant",
        content: typeof msg.text === "string" ? msg.text : "",
      },
    },
  };
}

/**
 * Map turn/completed → result event.
 */
export function normalizeTurnCompleted(params: TurnCompletedParams): KbblEvent {
  return {
    type: "result",
    payload: {
      type: "result",
      threadId: params.threadId,
      turn: params.turn,
      subtype: params.turn.status === "interrupted" ? "interrupted" : "success",
    },
  };
}

/**
 * Extract per-turn usage from a thread/tokenUsage/updated notification.
 * Uses the `last` bucket (per-turn delta) not `total` (session cumulative).
 */
export function extractTurnUsage(params: ThreadTokenUsageUpdatedParams): {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
} {
  const last = params.tokenUsage.last;
  return {
    inputTokens: last.inputTokens,
    outputTokens: last.outputTokens,
    cachedInputTokens: last.cachedInputTokens,
  };
}

/**
 * Map a raw Codex notification (method + params) to a kbbl event.
 * Returns null for methods that have no kbbl envelope mapping (skip them).
 */
export function normalizeNotification(
  method: string,
  params: unknown,
): KbblEvent | null {
  switch (method) {
    case "item/agentMessage/delta":
      return normalizeAgentMessageDelta(params as ItemAgentMessageDeltaParams);
    case "turn/completed":
      return normalizeTurnCompleted(params as TurnCompletedParams);
    case "item/completed": {
      const p = params as {
        item: unknown;
        threadId: string;
        turnId: string;
      };
      return normalizeAgentMessageCompleted(p.item, p.threadId, p.turnId);
    }
    default:
      return null;
  }
}

/**
 * Event types that should NOT be written to the JSONL transcript
 * but still fan out to live SSE subscribers.
 */
export const CODEX_NON_PERSISTED_EVENT_TYPES = new Set([
  "assistant_delta",
  "runtime_raw_codex_notification", // debug flag
  "codex_approval_server_request", // internal approval routing, never on disk
]);
