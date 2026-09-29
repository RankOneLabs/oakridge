import type { RunDetail, RunDiagnosisSession } from "../types";
import type { AppState } from "../../state/store";
import type { Sid } from "../../lib/ids";

export type RunSessionsRead =
  | { readonly kind: "loaded"; readonly sessions: readonly RunDiagnosisSession[] }
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" };

export const attemptsOf = (read: RunSessionsRead): readonly RunDiagnosisSession[] =>
  read.kind === "loaded" ? read.sessions : [];

export interface RunSessionAvailabilityInput {
  readonly run: RunDetail | undefined;
  readonly sessions: RunSessionsRead;
  readonly inventory: Pick<AppState, "sessions" | "hasInboxSnapshot" | "hasSessionSeed" | "removedSids">;
}

/** Historical diagnosis rows outlive their transcripts in kbbl. */
export const selectPurgedRunSessionIds = ({ run, sessions, inventory }: RunSessionAvailabilityInput): ReadonlySet<string> => {
  if (!inventory.hasInboxSnapshot || !inventory.hasSessionSeed) return inventory.removedSids;
  const candidates = new Set(attemptsOf(sessions).map((session) => session.session_id));
  for (const stage of run?.stages ?? []) {
    if (stage.delegated_kbbl_sid !== null) candidates.add(stage.delegated_kbbl_sid);
    for (const unit of stage.units ?? []) if (unit.sid !== null) candidates.add(unit.sid);
  }
  return new Set([
    ...inventory.removedSids,
    ...[...candidates].filter((sid) => !inventory.sessions.has(sid as Sid)),
  ]);
};
