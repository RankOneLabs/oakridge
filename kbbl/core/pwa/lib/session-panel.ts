import type { PlanProgress, UiUsage } from "../../acp/transcript-model";
import { openEnumSpelling } from "../../acp/transcript-transforms";
import type { SessionTranscriptState } from "../state/session-transcript-store";
import type { PendingSend, SessionSnapshot, TurnKey, UiOpenTurn } from "../types";
import { formatTokens } from "./format";
import { selectOperatorExecutionState, type OperatorExecutionState } from "./operator-state";
import { selectOpenPermissions } from "./session-items";

export interface PanelExecutionInput {
  transcript: SessionTranscriptState;
  snapshot: SessionSnapshot | null;
  pending_sends: readonly PendingSend[];
  is_interrupting: boolean;
}

interface RunningTurn {
  turn_key: TurnKey;
  text: string | null;
}

interface PanelTool {
  title: string;
  kind: string;
  status: string;
}

export function selectPanelExecution({
  transcript,
  snapshot,
  pending_sends,
  is_interrupting,
}: PanelExecutionInput): OperatorExecutionState {
  return selectOperatorExecutionState({
    sessionStatus: snapshot?.status ?? null,
    streamStatus: transcript.connection.status,
    historyLoaded: transcript.history !== null,
    pendingSends: pending_sends,
    isTurnActive: transcript.session_state.active_turn !== null,
    hasOpenPermission: transcript.session_state.open_permissions.length > 0,
    isInterrupting: is_interrupting,
  });
}

function selectRunningOpenTurn({ open_turns, session_state }: SessionTranscriptState): UiOpenTurn | null {
  return open_turns.find((turn) => turn.turnKey === session_state.active_turn) ?? null;
}

export function selectRunningTurn(transcript: SessionTranscriptState): RunningTurn | null {
  const turn_key = transcript.session_state.active_turn;
  if (turn_key === null) return null;
  return { turn_key, text: selectRunningOpenTurn(transcript)?.text ?? null };
}

export function selectQueuedTurns(transcript: SessionTranscriptState): UiOpenTurn[] {
  return transcript.open_turns
    .filter((turn) => turn.source === "operator" && turn.status === "accepted")
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
}

export function selectElapsedStartMs(
  transcript: SessionTranscriptState,
  local_wait_started_ms: number | null,
): number | null {
  const turn = selectRunningOpenTurn(transcript);
  return turn === null ? local_wait_started_ms : Date.parse(turn.createdAt);
}

export function selectUsageLabel(usage: UiUsage | null): string | null {
  if (usage === null || usage.used === null) return null;
  const used = formatTokens(usage.used);
  return usage.size !== null ? `${used}/${formatTokens(usage.size)}` : used;
}

export function selectLatestAgentLine(transcript: SessionTranscriptState): string | null {
  return transcript.session_state.latest_agent_line?.text ?? null;
}

export function selectActiveTool(transcript: SessionTranscriptState): PanelTool | null {
  const tool = transcript.session_state.active_tool;
  if (tool === null) return null;
  return {
    title: tool.title,
    kind: openEnumSpelling(tool.tool_kind),
    status: openEnumSpelling(tool.status),
  };
}

export function selectPlanProgress(transcript: SessionTranscriptState): PlanProgress | null {
  return transcript.session_state.plan_progress;
}

export function selectPanelPermissions(transcript: SessionTranscriptState) {
  return selectOpenPermissions(transcript.session_state);
}
