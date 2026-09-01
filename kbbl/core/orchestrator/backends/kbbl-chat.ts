import type {
  AcpError,
  AcpSessionSnapshot,
  AcpSessionStartSpec,
  Result,
} from "../../acp/types";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";

export const NO_ROUTING_ENTRY_ERROR_PREFIX = 'No routing entry for stage "';

/** The slice of AcpSessionService this backend needs (testable port). */
export interface KbblChatSessionPort {
  createSession(
    spec: AcpSessionStartSpec,
  ): Promise<Result<AcpSessionSnapshot, AcpError>>;
  getSession(sid: string): AcpSessionSnapshot | null;
}

export function createKbblChatBackend({
  acp,
}: {
  acp: KbblChatSessionPort;
}): ExecutionBackend {
  return {
    id: "kbbl_chat",

    async dispatch(stage: StageRow, inputRef: InputRef, renderedPrompt: string): Promise<{ session_ref: string }> {
      const routing = inputRef.modelSelection;
      if (!routing) {
        throw new Error(
          `${NO_ROUTING_ENTRY_ERROR_PREFIX}${stage.name}". Dispatcher must pass an explicit modelSelection from the owning Epic.`
        );
      }

      // Convert dev-flow EpicIdentity to the wire worktree shape at this
      // boundary so the ACP layer stays free of orchestrator domain knowledge.
      const epicIdentity = inputRef.worktreeIdentity;
      const worktree = epicIdentity
        ? (() => {
            const { epicSlug, cohortSlug, epicBranch, attemptSuffix } = epicIdentity;
            const suffix = attemptSuffix ? `/${attemptSuffix}` : "";
            return {
              branch_name: `cohort/${epicSlug}/${cohortSlug}${suffix}`,
              worktree_subdir: `${epicSlug}/${cohortSlug}${suffix}`,
              base_ref: `origin/${epicBranch}`,
            };
          })()
        : undefined;
      const created = await acp.createSession({
        initial_prompt: renderedPrompt,
        workdir: inputRef.workdir,
        name: inputRef.sessionName,
        model: routing.model,
        effort: routing.effort ?? undefined,
        runtime: routing.runtime,
        ...(worktree ? { worktree } : {}),
      });
      if (!created.ok) {
        throw new Error(
          `kbbl_chat dispatch failed: ${created.error.code} (${created.error.detail})`,
        );
      }
      return { session_ref: created.value.sid };
    },

    async status(session_ref: string): Promise<"running" | "completed" | "failed"> {
      const session = acp.getSession(session_ref);
      if (!session) return "failed";
      if (session.status === "failed") return "failed";
      if (session.status === "ended" || session.status === "fenced") return "completed";
      return "running";
    },
  };
}
