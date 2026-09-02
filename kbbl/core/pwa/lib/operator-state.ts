import type { PendingSend, SessionStatus, Status } from "../types";

export type OperatorExecutionState =
  | { kind: "loading_history" }
  | { kind: "sending" }
  | { kind: "queued"; count: number }
  | { kind: "waiting_permission" }
  | { kind: "interrupting" }
  | { kind: "running" }
  | { kind: "disconnected" }
  | { kind: "idle" }
  | { kind: "ended" }
  | { kind: "failed" }
  | { kind: "fenced" };

export interface OperatorStateInputs {
  readonly sessionStatus: SessionStatus | null;
  readonly streamStatus: Status;
  readonly historyLoaded: boolean;
  readonly pendingSends: readonly PendingSend[];
  readonly isTurnActive: boolean;
  readonly hasOpenPermission: boolean;
  readonly isInterrupting: boolean;
}

export function selectOperatorExecutionState(
  input: OperatorStateInputs,
): OperatorExecutionState {
  if (input.sessionStatus === "ended") return { kind: "ended" };
  if (input.sessionStatus === "failed") return { kind: "failed" };
  if (input.sessionStatus === "fenced") return { kind: "fenced" };
  if (!input.historyLoaded) return { kind: "loading_history" };
  if (input.isInterrupting) return { kind: "interrupting" };
  if (input.streamStatus === "disconnected" && input.isTurnActive) {
    return { kind: "disconnected" };
  }
  if (input.hasOpenPermission) return { kind: "waiting_permission" };
  if (input.isTurnActive) return { kind: "running" };
  const acceptedCount = input.pendingSends.filter(
    (send) => send.status === "accepted",
  ).length;
  if (acceptedCount > 0) return { kind: "queued", count: acceptedCount };
  if (input.pendingSends.some((send) => send.status === "sending")) {
    return { kind: "sending" };
  }
  return { kind: "idle" };
}

export function operatorStateLabel(state: OperatorExecutionState): string {
  switch (state.kind) {
    case "loading_history": return "loading history";
    case "sending": return "sending";
    case "queued": return `${state.count} queued`;
    case "waiting_permission": return "waiting for permission";
    case "interrupting": return "interrupting";
    case "running": return "running";
    case "disconnected": return "disconnected — outcome unknown";
    case "idle": return "idle";
    case "ended": return "ended";
    case "failed": return "failed";
    case "fenced": return "fenced";
  }
}
