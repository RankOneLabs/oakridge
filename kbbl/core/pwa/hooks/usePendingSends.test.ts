import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { TurnKey, UiOpenTurn } from "../types";
import { usePendingSends } from "./usePendingSends";

const turn: UiOpenTurn = {
  turnKey: "operator:message" as TurnKey,
  source: "operator",
  text: "queued input",
  status: "accepted",
  createdAt: "2026-09-02T00:00:00.000Z",
};

describe("usePendingSends", () => {
  it("shows sending before receipt and immediately removes it on a prompting receipt", () => {
    const { result } = renderHook(() => usePendingSends("sid", [], null, "idle"));
    act(() => result.current.addPendingSend(turn.text, "message"));
    expect(result.current.pendingSends[0]?.status).toBe("sending");
    act(() => result.current.acceptPendingSend("message", { turnKey: turn.turnKey, status: "prompting" }));
    expect(result.current.pendingSends).toEqual([]);
  });

  it("keeps an accepted receipt until it is represented by durable state and clears it on completion", () => {
    const { result, rerender } = renderHook(
      (openTurns: UiOpenTurn[]) => usePendingSends("sid", openTurns, null, "idle"),
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
      (openTurns: UiOpenTurn[]) => usePendingSends("sid", openTurns, null, "idle"),
      { initialProps: [] as UiOpenTurn[] },
    );
    act(() => result.current.addPendingSend(turn.text, "message"));
    rerender([turn]);
    rerender([]);
    act(() => result.current.acceptPendingSend("message", { turnKey: turn.turnKey, status: "accepted" }));
    expect(result.current.pendingSends).toEqual([]);
  });

  it("drops another session's pre-receipt send on navigation", () => {
    const { result, rerender } = renderHook((sid) => usePendingSends(sid, [], null, "idle"), { initialProps: "old" });
    act(() => result.current.addPendingSend("only in old", "message"));
    expect(result.current.pendingSends).toHaveLength(1);
    rerender("new");
    expect(result.current.pendingSends).toHaveLength(0);
  });
});
