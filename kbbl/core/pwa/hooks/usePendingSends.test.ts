import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TurnKey, UiOpenTurn } from "../types";
import { usePendingSends } from "./usePendingSends";

describe("usePendingSends", () => {
  const turnKey = (value: string) => value as TurnKey;
  it("reconciles identical messages by turn identity", () => {
    let echoedTurnKeys = new Set<string>();
    const openTurns: UiOpenTurn[] = [];
    const { result, rerender } = renderHook(() =>
      usePendingSends("sid-1", echoedTurnKeys, openTurns, "idle"),
    );
    act(() => {
      result.current.addPendingSend("same text", "first");
      result.current.addPendingSend("same text", "second");
      result.current.acceptPendingSend("first", {
        turnKey: turnKey("operator:first"),
        status: "accepted",
      });
      result.current.acceptPendingSend("second", {
        turnKey: turnKey("operator:second"),
        status: "accepted",
      });
    });

    echoedTurnKeys = new Set(["operator:second"]);
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
      usePendingSends("sid-1", new Set(), openTurns, "idle"),
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
      usePendingSends(sid, new Set(), [], "idle"),
    );
    act(() => result.current.addPendingSend("only in sid one", "message-1"));
    expect(result.current.pendingSends).toHaveLength(1);
    sid = "sid-2";
    rerender();
    expect(result.current.pendingSends).toHaveLength(0);
  });
});
