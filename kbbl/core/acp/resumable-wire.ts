/**
 * The resumable session contract (§11) between kbbl and oakridge-dbos's kbbl
 * adapter, declared once. kbbl's session routes build these bodies and parse
 * the requests; oakridge-dbos/src/adapters/kbbl.ts imports these types to
 * build requests and decode responses. Type-only, so the adapter pulls no
 * kbbl runtime code.
 */
import type { AcpFailureCode, AcpSessionStartSpec, AcpSessionWorkflowIdentity } from "./types";

/** Session status in the resumable vocabulary. */
export type ResumableSessionStatus = "starting" | "live" | "ended";

/** A session as the resumable routes report it. */
export interface ResumableSessionSnapshot {
  sid: string;
  name: string;
  status: ResumableSessionStatus;
  createdAt: string;
  lastActivityTs: string;
  runtimeId: string;
  model: string | null;
  effort: string | null;
  artifactId: string | null;
  projectWorkdir: string;
  worktreePath: string;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
}

/**
 * How a session's initial turn ended: it succeeded, someone closed the
 * session (an operator, or the attempt that holds it), or it failed with an
 * ACP failure code.
 */
export type ResumableEnd =
  | { readonly kind: "succeeded" }
  | { readonly kind: "closed" }
  | { readonly kind: "failed"; readonly code: AcpFailureCode; readonly detail: string };

/** The Oakridge attempt a session serves, as sent on the wire. */
export type ResumableWorkflowIdentity = AcpSessionWorkflowIdentity;

/** PUT /sessions/resumable/:sessionKey body. */
export interface ResumableEnsureRequest extends AcpSessionStartSpec { readonly workflow?: ResumableWorkflowIdentity }
/** PUT /sessions/resumable/:sessionKey response (201 when started). */
export interface ResumableEnsureResponse { readonly kind: "attached" | "started" | "terminal"; readonly session: ResumableSessionSnapshot }

/** GET /sessions/resumable/:sid/terminal, 202 while the initial turn runs. */
export interface ResumablePendingBody { readonly pending: true; readonly session: ResumableSessionSnapshot }
/** GET /sessions/resumable/:sid/terminal, 200 once the initial turn ended. */
export interface ResumableTerminalBody { readonly session: ResumableSessionSnapshot; readonly end: ResumableEnd }

/** PUT /sessions/resumable/:sid/input/:deliveryKey body. */
export interface ResumableInputRequest { readonly text: string }
