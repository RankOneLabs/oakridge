import { createElement } from "react";
import { act, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { EMPTY_SESSION_LIVE_STATE, streamEpoch } from "../../acp/transcript-model";
import { PendingUserBubble } from "../components/molecules/PendingUserBubble";
import type { PendingSend, SessionEpochFrame, TurnKey, UiOpenTurn } from "../types";
import { selectOperatorExecutionState } from "./operator-state";
import { selectPendingBubbles } from "./pending-bubbles";
import { applyEpochFrame, applyIncrementalFrames } from "./session-frames";

const openTurn: UiOpenTurn = {
  turnKey: "operator:message" as TurnKey,
  source: "operator",
  status: "accepted",
  text: "queued input",
  createdAt: "2026-09-02T00:00:00Z",
};

const epoch: SessionEpochFrame = {
  kind: "epoch", history_kind: "transcript", stream_epoch: streamEpoch("e1"), expired: false,
  summary: null, open_turns: [openTurn], session_state: EMPTY_SESSION_LIVE_STATE,
  items: [], has_earlier: true, is_truncated: false,
};

it("shows one durable bubble for an accepted operator turn and none once it starts prompting", () => {
  const state = applyEpochFrame(epoch);
  const local_sends: PendingSend[] = [{
    clientMessageId: "message", turnKey: openTurn.turnKey, text: openTurn.text, sentAt: 1, status: "accepted",
  }];
  expect(selectPendingBubbles({ ...state, local_sends, active_turn: null })).toEqual([
    { ...local_sends[0], sentAt: Date.parse(openTurn.createdAt) },
  ]);
  const prompting = applyIncrementalFrames(state, [
    { kind: "turn_state", state: "prompting", turn_key: openTurn.turnKey, stop_reason: null, detail: null },
  ]);
  expect(selectPendingBubbles({ ...prompting, local_sends, active_turn: null })).toEqual([]);
});

it("reopens a running turn without a pending bubble when the user message is outside the window", () => {
  const state = applyEpochFrame({
    ...epoch,
    open_turns: [{ ...openTurn, status: "prompting" }],
    session_state: { ...EMPTY_SESSION_LIVE_STATE, active_turn: openTurn.turnKey },
  });
  const pendingSends = selectPendingBubbles({ ...state, local_sends: [], active_turn: state.session_state.active_turn });
  expect(pendingSends).toEqual([]);
  expect(selectOperatorExecutionState({
    sessionStatus: "idle", streamStatus: "connected", historyLoaded: true, pendingSends,
    isTurnActive: state.session_state.active_turn !== null, hasOpenPermission: false, isInterrupting: false,
  })).toEqual({ kind: "running" });
});

it("labels queued and sending bubbles and marks sending as uncertain after two seconds", () => {
  vi.useFakeTimers();
  try {
    const props = { text: "input", sentAt: Date.now(), relativeText: "now", isLatest: false };
    const { rerender } = render(createElement(PendingUserBubble, { ...props, status: "accepted" }));
    expect(screen.getByText("queued")).toBeTruthy();
    rerender(createElement(PendingUserBubble, { ...props, status: "sending" }));
    expect(screen.getByText("sending…")).toBeTruthy();
    act(() => vi.advanceTimersByTime(2001));
    expect(screen.getByText("delivery uncertain…")).toBeTruthy();
    expect(screen.queryByText("starting…")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
