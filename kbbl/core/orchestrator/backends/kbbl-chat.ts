import type { SessionManager } from "../../session/session-manager";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";

// Cost-engineering rule: plan in Opus, build in Sonnet. Resolved per stage
// so dispatcher-spawned sessions don't fall through to the user-global default.
const STAGE_MODEL: Record<string, string> = {
  planner1: "claude-opus-4-7",
  planner2: "claude-opus-4-7",
  build: "claude-sonnet-4-6",
};

export function createKbblChatBackend({ manager }: { manager: SessionManager }): ExecutionBackend {
  return {
    id: "kbbl_chat",

    async dispatch(stage: StageRow, inputRef: InputRef, renderedPrompt: string): Promise<{ session_ref: string }> {
      const session = await manager.create({
        workdir: inputRef.workdir,
        name: inputRef.sessionName,
        model: STAGE_MODEL[stage.name] ?? null,
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
