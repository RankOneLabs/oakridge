import { expect, it } from "vitest";

import {
  EMPTY_SESSION_LIVE_STATE, permissionRequestId, streamEpoch, transcriptItemId, transcriptSeq,
  type PermissionItem,
} from "../../acp/transcript-model";
import { INITIAL_SESSION_TRANSCRIPT_STATE } from "../state/session-transcript-store";
import type { PendingSend, SessionEpochFrame, SessionSnapshot, TurnKey, UiOpenTurn } from "../types";
import { applyEpochFrame, applyIncrementalFrames } from "./session-frames";
import {
  selectActiveTool, selectElapsedStartMs, selectLatestAgentLine, selectPanelExecution,
  selectPanelPermissions, selectPlanProgress, selectQueuedTurns, selectRunningTurn,
  selectUsageLabel, type PanelExecutionInput,
} from "./session-panel";

function permission(index: number): PermissionItem {
  const seq = transcriptSeq(index);
  return {
    kind: "permission", seq, id: transcriptItemId(seq), request_id: permissionRequestId(`request-${index}`),
    title: `Permission ${index}`, options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
    resolution: null,
  };
}

const running: UiOpenTurn = {
  turnKey: "operator:running" as TurnKey, source: "operator", status: "prompting",
  text: "Run checks", createdAt: "2026-09-02T00:01:00Z",
};
const permissions = [permission(2), permission(3)];
const usage = { used: 1200, size: 100_000, cost: null };
const epoch: SessionEpochFrame = {
  kind: "epoch", stream_epoch: streamEpoch("epoch-1"), history_kind: "transcript",
  expired: false, summary: null, open_turns: [running], items: [], has_earlier: true, is_truncated: false,
  session_state: {
    ...EMPTY_SESSION_LIVE_STATE, active_turn: running.turnKey, usage,
    latest_agent_line: { item_id: transcriptItemId(transcriptSeq(0)), text: "Checking output" },
    active_tool: {
      item_id: transcriptItemId(transcriptSeq(1)), tool_call_id: "tool-1", title: "Read source",
      tool_kind: { is_recognized: false, raw: "custom-reader" },
      status: { is_recognized: true, value: "in_progress" },
    },
    plan_progress: { total: 3, completed: 1, current_entry: "Check output" },
    open_permissions: permissions,
  },
};
const transcript = applyEpochFrame(epoch);
const execution: PanelExecutionInput = {
  transcript, snapshot: null, pending_sends: [], is_interrupting: false,
};

it("selects execution from authoritative turns, permissions, connection, and history", () => {
  const runningOnly = applyEpochFrame({
    ...epoch, session_state: { ...epoch.session_state, open_permissions: [] },
  });
  expect(selectPanelExecution({ ...execution, transcript: runningOnly })).toEqual({ kind: "running" });
  expect(selectPanelExecution(execution)).toEqual({ kind: "waiting_permission" });
  expect(selectPanelExecution({
    ...execution, transcript: { ...runningOnly, connection: { status: "disconnected", stream_error: null } },
  })).toEqual({ kind: "disconnected" });
  expect(selectPanelExecution({ ...execution, transcript: INITIAL_SESSION_TRANSCRIPT_STATE }))
    .toEqual({ kind: "loading_history" });
});

it("reports the accepted pending-send count for queued execution", () => {
  const accepted: PendingSend = { clientMessageId: "a", turnKey: running.turnKey, status: "accepted", text: "a", sentAt: 1 };
  expect(selectPanelExecution({
    ...execution, transcript: applyEpochFrame({ ...epoch, session_state: EMPTY_SESSION_LIVE_STATE }),
    pending_sends: [accepted, { ...accepted, clientMessageId: "b" }, { ...accepted, status: "sending" }],
  })).toEqual({ kind: "queued", count: 2 });
});

it.each(["ended", "failed", "fenced"] as const)("reports the %s snapshot status", (status) => {
  expect(selectPanelExecution({ ...execution, snapshot: { status } as SessionSnapshot })).toEqual({ kind: status });
});

it("uses the running turn's acceptance time across epochs and falls back to local wait", () => {
  const reconnected = applyEpochFrame({ ...epoch, stream_epoch: streamEpoch("epoch-2") }, transcript);
  expect(selectElapsedStartMs(reconnected, 42)).toBe(Date.parse(running.createdAt));
  expect(selectElapsedStartMs({ ...transcript, open_turns: [] }, 42)).toBe(42);
});

it("returns the running turn text when the matching open turn exists", () => {
  expect(selectRunningTurn(transcript)).toEqual({ turn_key: running.turnKey, text: running.text });
  expect(selectRunningTurn({ ...transcript, open_turns: [] })).toEqual({ turn_key: running.turnKey, text: null });
  expect(selectRunningTurn(INITIAL_SESSION_TRANSCRIPT_STATE)).toBeNull();
});

it("queues only accepted operator turns in chronological order with stable ties", () => {
  const older: UiOpenTurn = { ...running, status: "accepted", text: "older", createdAt: "2026-09-02T00:00:00Z" };
  const tied: UiOpenTurn = { ...older, text: "tied" };
  const newer: UiOpenTurn = { ...older, text: "newer", createdAt: running.createdAt };
  const withQueue = applyEpochFrame({
    ...epoch, open_turns: [newer, running, older, { ...older, source: "initial" }, tied, { ...older, source: "collaboration" }],
  });
  expect(selectQueuedTurns(withQueue)).toEqual([older, tied, newer]);
});

it("formats context usage with or without a capacity", () => {
  expect(selectUsageLabel(transcript.session_state.usage)).toBe("1k tokens/100k tokens");
  expect(selectUsageLabel({ ...usage, size: null })).toBe("1k tokens");
  expect(selectUsageLabel({ ...usage, used: null })).toBeNull();
  expect(selectUsageLabel(null)).toBeNull();
});

it("reads the latest output beyond the transcript window", () => {
  expect(selectLatestAgentLine(transcript)).toBe("Checking output");
});

it("reads the active tool beyond the transcript window and spells both forms of open enum", () => {
  expect(selectActiveTool(transcript)).toEqual({ title: "Read source", kind: "custom-reader", status: "in_progress" });
});

it("reads plan progress beyond the transcript window", () => {
  expect(selectPlanProgress(transcript)).toEqual({ completed: 1, total: 3, current_entry: "Check output" });
});

it("reads both open permissions beyond the transcript window", () => {
  expect(selectPanelPermissions(transcript).map((item) => item.requestId)).toEqual(["request-2", "request-3"]);
});

it("reflects live changes beyond the window without transcript item frames", () => {
  const updated = applyIncrementalFrames(transcript, [{
    kind: "session_state",
    state: {
      ...epoch.session_state,
      latest_agent_line: { item_id: transcriptItemId(transcriptSeq(0)), text: "Output checked" },
      open_permissions: permissions.slice(1),
    },
  }]);
  expect(updated.ordered_ids).toEqual([]);
  expect(selectLatestAgentLine(updated)).toBe("Output checked");
  expect(selectPanelPermissions(updated).map((item) => item.requestId)).toEqual(["request-3"]);
});

it("replaces activity with the new authoritative epoch on reconnect", () => {
  const reconnected = applyEpochFrame({
    ...epoch, stream_epoch: streamEpoch("epoch-2"),
    session_state: {
      ...EMPTY_SESSION_LIVE_STATE,
      latest_agent_line: { item_id: transcriptItemId(transcriptSeq(4)), text: "Reconnected output" },
    },
  }, transcript);
  expect(selectLatestAgentLine(reconnected)).toBe("Reconnected output");
  expect(selectActiveTool(reconnected)).toBeNull();
  expect(selectPlanProgress(reconnected)).toBeNull();
  expect(selectPanelPermissions(reconnected)).toEqual([]);
});
