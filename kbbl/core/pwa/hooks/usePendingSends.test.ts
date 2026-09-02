import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AcpUiEvent, TurnKey, UiOpenTurn } from "../types";
import { usePendingSends } from "./usePendingSends";

describe("usePendingSends", () => {
  it("reconciles identical messages by turn identity", () => {
    let events: AcpUiEvent[] = [];
    const openTurns: UiOpenTurn[] = [];
    const { result, rerender } = renderHook(() =>
      usePendingSends("sid-1", events, openTurns, "idle"),
    );
    act(() => {
      result.current.addPendingSend("same text", "first");
      result.current.addPendingSend("same text", "second");
      result.current.acceptPendingSend("first", {
        turnKey: "operator:first",
        status: "accepted",
      });
      result.current.acceptPendingSend("second", {
        turnKey: "operator:second",
        status: "accepted",
      });
    });

    events = [{
      kind: "user_message",
      id: "operator:second",
      content: [{ type: "text", text: "same text" }],
      replayed: false,
    }];
    rerender();
    expect(result.current.pendingSends.map((send) => send.clientMessageId)).toEqual([
      "first",
    ]);
  });

  it("reconstructs a queued operator message from the durable epoch projection", () => {
    const openTurns: UiOpenTurn[] = [{
      turnKey: "operator:restored" as TurnKey,
      source: "operator",
      text: "survive navigation",
      status: "accepted",
      createdAt: "2026-09-02T00:00:00.000Z",
    }];
    const { result } = renderHook(() =>
      usePendingSends("sid-1", [], openTurns, "idle"),
    );
    expect(result.current.pendingSends[0]).toMatchObject({
      clientMessageId: "restored",
      text: "survive navigation",
      status: "accepted",
    });
  });

  it("drops another session's pre-receipt send on navigation", () => {
    let sid = "sid-1";
    const { result, rerender } = renderHook(() =>
      usePendingSends(sid, [], [], "idle"),
    );
    act(() => result.current.addPendingSend("only in sid one", "message-1"));
    expect(result.current.pendingSends).toHaveLength(1);
    sid = "sid-2";
    rerender();
    expect(result.current.pendingSends).toHaveLength(0);
  });
});
