import type { KbblConfig } from "../../config";
import type { RuntimeId } from "../../runtime";
import type { SessionManager } from "../../session/session-manager";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";

// Agent-dev flow routing. The runtime comes from the owning Epic, selected in
// the create-plan UI. Planner stages use the planner model; build uses the
// builder model. Config stage overrides cover legacy refs that do not carry an
// Epic-level runtime selection.
type RoutedStage = "spec_analyzer" | "plan_writer" | "brief_writer" | "assessor" | "build";

const STAGE_ROUTING: Record<RuntimeId, Record<RoutedStage, { runtime: RuntimeId; model: string }>> = {
  "claude-code": {
    spec_analyzer: { runtime: "claude-code", model: "claude-opus-4-8" },
    plan_writer:   { runtime: "claude-code", model: "claude-opus-4-8" },
    brief_writer:  { runtime: "claude-code", model: "claude-opus-4-8" },
    assessor:      { runtime: "claude-code", model: "claude-opus-4-8" },
    build:         { runtime: "claude-code", model: "claude-sonnet-4-6" },
  },
  codex: {
    spec_analyzer: { runtime: "codex", model: "gpt-5.5" },
    plan_writer:   { runtime: "codex", model: "gpt-5.5" },
    brief_writer:  { runtime: "codex", model: "gpt-5.5" },
    assessor:      { runtime: "codex", model: "gpt-5.5" },
    build:         { runtime: "codex", model: "gpt-5.4-mini" },
  },
};

function isRoutedStage(name: string): name is RoutedStage {
  return Object.hasOwn(STAGE_ROUTING["claude-code"], name);
}

function supportedRoutedStages(): string {
  return Object.keys(STAGE_ROUTING["claude-code"]).join(", ");
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
      const agentRuntime = inputRef.agentRuntime ?? "claude-code";
      const defaultRouting = isRoutedStage(stage.name) ? STAGE_ROUTING[agentRuntime][stage.name] : null;
      const stageOverride =
        inputRef.modelSelection === undefined &&
        inputRef.agentRuntime === undefined &&
        config?.runtime.stages &&
        Object.hasOwn(config.runtime.stages, stage.name)
          ? config.runtime.stages[stage.name]
          : undefined;
      const routing = inputRef.modelSelection ?? stageOverride ?? defaultRouting;
      if (!routing) {
        throw new Error(
          `No routing entry for stage "${stage.name}". Supported routed stages: ${supportedRoutedStages()}. Add an override via config.runtime.stages or pass modelSelection from the dispatcher.`
        );
      }

      const session = await manager.create({
        workdir: inputRef.workdir,
        name: inputRef.sessionName,
        model: routing.model,
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
