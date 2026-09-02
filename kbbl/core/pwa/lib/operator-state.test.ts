import { describe, expect, it } from "vitest";

import type { PendingSend } from "../types";
import { selectOperatorExecutionState } from "./operator-state";

const base = {
  sessionStatus: "idle" as const,
  streamStatus: "connected" as const,
  historyLoaded: true,
  pendingSends: [] as PendingSend[],
  isTurnActive: false,
  hasOpenPermission: false,
  isInterrupting: false,
};

describe("selectOperatorExecutionState", () => {
  it("shows durable accepted work as queued, never running", () => {
    const state = selectOperatorExecutionState({
      ...base,
      pendingSends: [{
        clientMessageId: "message-1",
        turnKey: "operator:message-1",
        text: "next",
        sentAt: 1,
        status: "accepted",
      }],
    });
    expect(state).toEqual({ kind: "queued", count: 1 });
  });

  it("distinguishes history load, permission wait, interruption, and disconnect", () => {
    expect(selectOperatorExecutionState({ ...base, historyLoaded: false }).kind).toBe("loading_history");
    expect(selectOperatorExecutionState({ ...base, hasOpenPermission: true }).kind).toBe("waiting_permission");
    expect(selectOperatorExecutionState({ ...base, isInterrupting: true }).kind).toBe("interrupting");
    expect(selectOperatorExecutionState({
      ...base,
      streamStatus: "disconnected",
      isTurnActive: true,
    }).kind).toBe("disconnected");
  });
});
