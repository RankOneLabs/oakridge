import type { RuntimeId } from "../runtime";

export type SessionId = string & { readonly __brand: "SessionId" };
export type ArtifactId = string & { readonly __brand: "ArtifactId" };

export type SessionStatus = "starting" | "live" | "compacting" | "ended";
export type SessionEndReason = "user_closed" | "subprocess_exited" | "compacted";

export interface ResultUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface SessionSnapshot {
  sid: string;
  name: string;
  workdir: string;
  status: SessionStatus;
  createdAt: string;
  lastActivityTs: string;
  runtimeId: RuntimeId;
  runtimeSid: string | null;
  /** @deprecated Use runtimeSid. */
  ccSid: string | null;
  parentCcSid: string | null;
  parentOakridgeSid: string | null;
  artifactId: ArtifactId | null;
  pendingCount: number;
  yoloMode: boolean;
  allowedTools: string[];
  lastResultUsage: ResultUsage | null;
  worktreePath: string | null;
  worktreeBranch: string | null;
  worktreeBaseRef: string | null;
  projectWorkdir: string | null;
  model: string | null;
  effort: string | null;
  initialObservedModel: string | null;
  observedModel: string | null;
  endReason: SessionEndReason | null;
  successorSid: string | null;
}
