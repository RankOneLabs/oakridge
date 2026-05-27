import type { KbblConfig } from "../../config";
import type { RuntimeId } from "../../runtime";
import type { SessionManager } from "../../session/session-manager";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";

// Cost-engineering rule: plan in Opus, build in Sonnet. Resolved per stage
// so dispatcher-spawned sessions don't fall through to the user-global default.
type RoutedStage = "planner1" | "planner2" | "planner2_batch" | "planner3" | "build";

const STAGE_ROUTING: Record<RoutedStage, { runtime: RuntimeId; model: string }> = {
  planner1:       { runtime: "claude-code", model: "claude-opus-4-7" },
  planner2:       { runtime: "claude-code", model: "claude-opus-4-7" },
  planner2_batch: { runtime: "claude-code", model: "claude-opus-4-7" },
  planner3:       { runtime: "claude-code", model: "claude-opus-4-7" },
  build:          { runtime: "claude-code", model: "claude-sonnet-4-6" },
};

function isRoutedStage(name: string): name is RoutedStage {
  return Object.hasOwn(STAGE_ROUTING, name);
}

export function createKbblChatBackend({
  manager,
  config,
}: {
  manager: SessionManager;
  config?: KbblConfig;
}): ExecutionBackend {
  return {
    id: "kbbl_chat",

    async dispatch(stage: StageRow, inputRef: InputRef, renderedPrompt: string): Promise<{ session_ref: string }> {
      const defaultRouting = isRoutedStage(stage.name) ? STAGE_ROUTING[stage.name] : null;
      const stageOverride =
        config?.runtime.stages && Object.hasOwn(config.runtime.stages, stage.name)
          ? config.runtime.stages[stage.name]
          : undefined;
      const routing = stageOverride ?? defaultRouting;

      const session = await manager.create({
        workdir: inputRef.workdir,
        name: inputRef.sessionName,
        model: routing?.model ?? null,
        runtime: routing?.runtime,
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
