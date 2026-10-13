import type { OperatorRunEvent } from "../operator-contracts";
import { formatRunWorkspaceHash } from "../../lib/hash";

export interface RunNotification {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly href: string;
}

/**
 * A unit that now waits on the operator, or one that just finished, is worth a
 * toast; other events are not. A unit ends cancelled only when its run was, so
 * a cancelled run reads as cancelled, not as a success.
 */
export const selectEventNotification = (event: OperatorRunEvent): RunNotification | null => {
  const href = `#${formatRunWorkspaceHash(event.run_id, event.unit_id)}`;
  if (event.awaiting !== null) return { kind: "info", message: `${event.unit_key}: ${event.awaiting.label}`, href };
  if (event.is_terminal && event.run_status === "cancelled") return { kind: "info", message: `${event.unit_key} cancelled`, href };
  if (event.is_terminal) return { kind: "success", message: `${event.unit_key} finished`, href };
  return null;
};
