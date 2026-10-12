import type { OperatorRunEvent } from "../operator-contracts";
import { formatRunWorkspaceHash } from "../../lib/hash";

export interface RunNotification {
  readonly kind: "success" | "error" | "info";
  readonly message: string;
  readonly href: string;
}

/** A unit that now waits on the operator, or one that just finished, is worth a toast; other events are not. */
export const selectEventNotification = (event: OperatorRunEvent): RunNotification | null => {
  if (event.unit_id === null) return null;
  const label = event.unit_key ?? event.unit_id;
  const href = `#${formatRunWorkspaceHash(event.run_id, event.unit_id)}`;
  if (event.attention !== null) return { kind: "info", message: `${label}: ${event.attention.label}`, href };
  if (event.is_terminal) return { kind: "success", message: `${label} finished`, href };
  return null;
};
