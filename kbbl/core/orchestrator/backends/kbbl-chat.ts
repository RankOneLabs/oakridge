import type { SessionManager } from "../../session/session-manager";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";

export function createKbblChatBackend({ manager }: { manager: SessionManager }): ExecutionBackend {
  return {
    id: "kbbl_chat",

    async dispatch(_stage: StageRow, inputRef: InputRef, renderedPrompt: string): Promise<{ session_ref: string }> {
      const session = await manager.create({ workdir: inputRef.workdir, model: null });
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
