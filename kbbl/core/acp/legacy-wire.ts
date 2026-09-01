// Wire-compatibility projections (§11, §14.1): ACP session state rendered
// in the legacy vocabulary that oakridge-dbos's KbblExecutorAdapter and the
// current PWA already parse. This module exists so the DBOS contract does
// not move in the same PR that swaps the runtime; it is deleted when the
// PWA and DBOS adapters consume ACP shapes natively.

import type {
  AcpSessionSnapshot,
  AcpSessionStatus,
  TerminalObservation,
} from "./types";

/** Legacy SessionStatus as parseEnsureResponse enforces it. */
export type LegacyWireStatus = "starting" | "live" | "compacting" | "ended";

export function toLegacyStatus(status: AcpSessionStatus): LegacyWireStatus {
  switch (status) {
    case "provisioning":
      return "starting";
    case "idle":
    case "prompting":
    // An unknown session's turn outcome is uncertain, but the session
    // itself is still attached — reporting "ended" would make DBOS read
    // a missing exit code as failure before observation says so.
    case "unknown":
      return "live";
    case "ended":
    case "fenced":
    case "failed":
      return "ended";
  }
}

/**
 * Legacy endReason vocabulary. DBOS branches on exactly one value —
 * "user_closed" means cancelled — and the ensure parser additionally
 * tolerates subprocess_exited/compacted. Fences and operator closes both
 * project to user_closed; failures to subprocess_exited.
 */
export function toLegacyEndReason(
  status: AcpSessionStatus,
  endReason: string | null,
): "user_closed" | "subprocess_exited" | null {
  if (status === "fenced") return "user_closed";
  if (status === "ended") return "user_closed";
  if (status === "failed") return "subprocess_exited";
  return endReason === "user_closed" ? "user_closed" : null;
}

/**
 * The legacy snapshot shape (core/session/types.ts SessionSnapshot) built
 * from an ACP session. Fields the ACP world deliberately lacks — runtime
 * session ids, yolo mode, compaction chains — render as their empty
 * values; the PWA treats those as "feature not present".
 */
export function toLegacySnapshot(
  snapshot: AcpSessionSnapshot,
): Record<string, unknown> {
  return {
    sid: snapshot.sid,
    name: snapshot.name,
    workdir: snapshot.worktree_path,
    status: toLegacyStatus(snapshot.status),
    createdAt: snapshot.created_at,
    lastActivityTs: snapshot.last_activity_at,
    runtimeId: snapshot.agent_profile,
    runtimeSid: snapshot.acp_session_id,
    ccSid: null,
    parentCcSid: null,
    parentOakridgeSid: null,
    artifactId: snapshot.artifact_id,
    pendingCount: 0,
    yoloMode: false,
    allowedTools: [],
    lastResultUsage: null,
    worktreePath: snapshot.worktree_path,
    worktreeBranch: snapshot.worktree_branch,
    worktreeBaseRef: snapshot.worktree_base_ref,
    projectWorkdir: snapshot.project_workdir,
    model: snapshot.requested_model,
    effort: snapshot.requested_effort,
    initialObservedModel: null,
    observedModel: null,
    endReason: toLegacyEndReason(snapshot.status, snapshot.end_reason),
    exitCode: null,
    successorSid: null,
  };
}

/**
 * §11.2 terminal-route body for a non-pending observation. Success and
 * failure keep the legacy `exit_code` compatibility field; failures add
 * the structured `failure` extension so a follow-up DBOS change can
 * surface the real ACP failure code.
 */
export function toTerminalBody(
  observation: Exclude<TerminalObservation, { kind: "pending" }>,
): Record<string, unknown> {
  const session = toLegacySnapshot(observation.session);
  if (observation.kind === "succeeded") {
    return { session: { ...session, endReason: null }, exit_code: 0 };
  }
  // A session the operator or DBOS closed reads as cancellation, not
  // failure — DBOS keys cancellation off endReason "user_closed".
  const closed =
    observation.session.status === "fenced" ||
    observation.session.end_reason === "user_closed" ||
    observation.session.end_reason === "fenced";
  if (closed) {
    return { session: { ...session, endReason: "user_closed" }, exit_code: 1 };
  }
  return {
    session: { ...session, endReason: "subprocess_exited" },
    exit_code: 1,
    failure: {
      code: observation.failure_code,
      detail: observation.failure_detail,
    },
  };
}
