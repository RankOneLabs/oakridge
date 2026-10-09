import type { StageOperatorRole } from "./workflow";

/**
 * Adapter-owned name for why a role is being launched. Core carries the name
 * but does not close over an adapter's vocabulary.
 */
type SessionLaunchReasonName = string;

/** Durable reference from a session to the transition that launched it. */
interface SessionLaunchReason {
  readonly transition_id: import("./primitives").RunTransitionId;
  readonly name: SessionLaunchReasonName;
}

/** Immutable launch material selected by, and readable from, one transition. */
export interface CommittedSessionLaunch {
  readonly reason: SessionLaunchReason;
  readonly session_role: StageOperatorRole;
  readonly prompt: { readonly template_path: string; readonly content: string };
  readonly existing_pull_request: string | null;
}
