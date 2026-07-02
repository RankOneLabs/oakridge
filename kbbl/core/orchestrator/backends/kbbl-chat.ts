import type { SessionManager } from "../../session/session-manager";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";

export const NO_ROUTING_ENTRY_ERROR_PREFIX = 'No routing entry for stage "';

export function createKbblChatBackend({
  manager,
}: {
  manager: SessionManager;
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

      const session = await manager.create({
        workdir: inputRef.workdir,
        name: inputRef.sessionName,
        model: routing.model,
        effort: routing.effort ?? undefined,
        runtime: routing.runtime,
        ...(inputRef.worktreeIdentity ? { worktreeIdentity: inputRef.worktreeIdentity } : {}),
      });
      await session.writeInput(renderedPrompt);
      return { session_ref: session.oakridgeSid };
    },

    async status(session_ref: string): Promise<"running" | "completed" | "failed"> {
      const session = manager.get(session_ref);
      if (!session) return "failed";
      if (session.status === "ended") return "completed";
      return "running";
    },
  };
}
