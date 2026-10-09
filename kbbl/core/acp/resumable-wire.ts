/**
 * The resumable session contract (§11) between kbbl and oakridge-dbos's kbbl
 * adapter, declared once. kbbl's session routes build these bodies and parse
 * the requests; oakridge-dbos/src/adapters/kbbl.ts imports these types to
 * build requests and decode responses. Type-only, so the adapter pulls no
 * kbbl runtime code.
 */
import type { AcpFailureCode, AcpSessionStartSpec, AcpSessionWorkflowIdentity } from "./types";

/** Session status in the resumable vocabulary. */
export type ResumableSessionStatus = "starting" | "live" | "compacting" | "ended";
/** "user_closed" means cancelled; "subprocess_exited" means the session failed. */
export type ResumableEndReason = "user_closed" | "subprocess_exited";

/**
 * Session snapshot on the resumable routes. Fields the ACP world deliberately
 * lacks (runtime session ids, yolo mode, compaction chains) are pinned to
 * their empty values.
 */
export interface ResumableSessionSnapshot {
  sid: string;
  name: string;
  workdir: string;
  status: ResumableSessionStatus;
  createdAt: string;
  lastActivityTs: string;
  runtimeId: string;
  runtimeSid: string | null;
  ccSid: null;
  parentCcSid: null;
  parentOakridgeSid: null;
  artifactId: string | null;
  pendingCount: number;
  yoloMode: boolean;
  allowedTools: string[];
  lastResultUsage: null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
  projectWorkdir: string | null;
  model: string | null;
  effort: string | null;
  initialObservedModel: null;
  observedModel: null;
  endReason: ResumableEndReason | null;
  exitCode: null;
  successorSid: null;
}

/** Workflow identity a run attaches to its session, as sent on the wire. */
export type ResumableWorkflowIdentity = Pick<AcpSessionWorkflowIdentity, "workflow_run_id" | "stage_instance_id" | "unit_id">
  & { readonly [Field in "cohort_id" | "operator_role" | "cohort_title" | "repository_key"]?: string };

/** PUT /sessions/resumable/:sessionKey body. */
export interface ResumableEnsureRequest extends AcpSessionStartSpec { readonly workflow?: ResumableWorkflowIdentity }
/** PUT /sessions/resumable/:sessionKey response (201 when started). */
export interface ResumableEnsureResponse { readonly kind: "attached" | "started" | "terminal"; readonly session: ResumableSessionSnapshot }

/** Present on a failed terminal body; the actual reason, since exit_code is always 1. */
export interface ResumableTerminalFailure { readonly code: AcpFailureCode; readonly detail: string }
/** GET /sessions/resumable/:sid/terminal, 202 while the initial turn runs. */
export interface ResumablePendingBody { readonly pending: true; readonly session: ResumableSessionSnapshot }
/** GET /sessions/resumable/:sid/terminal, 200 once the initial turn ended. */
export interface ResumableTerminalBody { readonly session: ResumableSessionSnapshot; readonly exit_code: number; readonly failure?: ResumableTerminalFailure }

/** PUT /sessions/resumable/:sid/input/:deliveryKey body. */
export interface ResumableInputRequest { readonly text: string }
