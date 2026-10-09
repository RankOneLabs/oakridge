import type { OperatorRunEvent } from "../operator-contracts";
import { formatRunWorkspaceHash } from "../../lib/hash";

export interface RunNotification {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly href: string;
}

/** A scope that now waits on the operator, or one that just finished, is worth a toast; other transitions are not. */
export const selectEventNotification = (event: OperatorRunEvent): RunNotification | null => {
  const href = `#${formatRunWorkspaceHash(event.run_id, event.scope_id)}`;
  if (event.attention !== null) return { kind: "info", message: `${event.scope_key}: ${event.attention.label}`, href };
  if (event.is_terminal && event.decision === "apply") return { kind: "success", message: `${event.scope_key} finished`, href };
  return null;
};
