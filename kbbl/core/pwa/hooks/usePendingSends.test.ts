import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { applyIncrementalFrames } from "../lib/session-frames";
import { INITIAL_SESSION_TRANSCRIPT_STATE } from "../state/session-transcript-store";
import type { TurnKey, UiOpenTurn } from "../types";
import { usePendingSends } from "./usePendingSends";

const turn: UiOpenTurn = {
  turnKey: "operator:message" as TurnKey,
  source: "operator",
  text: "queued input",
  status: "accepted",
  createdAt: "2026-09-02T00:00:00.000Z",
};

const idleSession = {
  openTurns: [],
  activeTurn: null,
  terminalTurnKeys: INITIAL_SESSION_TRANSCRIPT_STATE.terminal_turn_keys,
  sessionStatus: "idle",
} as const;

describe("usePendingSends", () => {
  it("shows sending before receipt and immediately removes it on a prompting receipt", () => {
    const { result } = renderHook(() => usePendingSends("sid", idleSession));
    act(() => result.current.addPendingSend(turn.text, "message"));
    expect(result.current.pendingSends[0]?.status).toBe("sending");
    act(() => result.current.acceptPendingSend("message", { turnKey: turn.turnKey, status: "prompting" }));
    expect(result.current.pendingSends).toEqual([]);
  });

  it("keeps an accepted receipt until it is represented by durable state and clears it on completion", () => {
    const { result, rerender } = renderHook(
      (openTurns: UiOpenTurn[]) => usePendingSends("sid", { ...idleSession, openTurns }),
      { initialProps: [] as UiOpenTurn[] },
    );
    act(() => {
      result.current.addPendingSend(turn.text, "message");
      result.current.acceptPendingSend("message", { turnKey: turn.turnKey, status: "accepted" });
    });
    expect(result.current.pendingSends.map(({ status }) => status)).toEqual(["accepted"]);
    rerender([turn]);
    expect(result.current.pendingSends.map(({ sentAt }) => sentAt)).toEqual([Date.parse(turn.createdAt)]);
    rerender([]);
    expect(result.current.pendingSends).toEqual([]);
  });

  it("clears a late receipt for a turn that already left the open turns", () => {
    const { result, rerender } = renderHook(
      (openTurns: UiOpenTurn[]) => usePendingSends("sid", { ...idleSession, openTurns }),
      { initialProps: [] as UiOpenTurn[] },
    );
    act(() => result.current.addPendingSend(turn.text, "message"));
    rerender([turn]);
    expect(result.current.pendingSends.map(({ status }) => status)).toEqual(["accepted"]);
    rerender([{ ...turn, status: "prompting" }]);
    expect(result.current.pendingSends).toEqual([]);
    rerender([]);
    act(() => result.current.acceptPendingSend("message", { turnKey: turn.turnKey, status: "accepted" }));
    expect(result.current.pendingSends).toEqual([]);
  });

  it.each(["before", "after"])("clears an accepted receipt arriving %s a batched prompting and idle transition", (receiptTiming) => {
    const { result, rerender } = renderHook(
      (state) => usePendingSends("sid", {
        ...idleSession,
        openTurns: state.open_turns,
        activeTurn: state.session_state.active_turn,
        terminalTurnKeys: state.terminal_turn_keys,
      }),
      { initialProps: INITIAL_SESSION_TRANSCRIPT_STATE },
    );
    const accept = () => result.current.acceptPendingSend("message", { turnKey: turn.turnKey, status: "accepted" });
    act(() => result.current.addPendingSend(turn.text, "message"));
    if (receiptTiming === "before") act(accept);
    const transition = { kind: "turn_state", turn_key: turn.turnKey, stop_reason: null, detail: null } as const;
    rerender(applyIncrementalFrames(INITIAL_SESSION_TRANSCRIPT_STATE, [
      { ...transition, state: "prompting" },
      { ...transition, state: "idle" },
    ]));
    expect(result.current.pendingSends).toEqual([]);
    if (receiptTiming === "after") act(accept);
    expect(result.current.pendingSends).toEqual([]);
  });

  it("drops another session's pre-receipt send on navigation", () => {
    const { result, rerender } = renderHook((sid) => usePendingSends(sid, idleSession), { initialProps: "old" });
    act(() => result.current.addPendingSend("only in old", "message"));
    expect(result.current.pendingSends).toHaveLength(1);
    rerender("new");
    expect(result.current.pendingSends).toHaveLength(0);
  });
});
