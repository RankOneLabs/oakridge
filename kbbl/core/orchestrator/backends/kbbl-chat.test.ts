import { describe, expect, test } from "bun:test";
import { createKbblChatBackend } from "./kbbl-chat";
import type { InputRef, StageRow } from "./interface";
import type { SessionManager } from "../../session/session-manager";
import { KbblConfigSchema } from "../../config";
import type { RuntimeId } from "../../runtime";

interface FakeCreateOpts {
  workdir: string;
  name: string;
  model: string | null;
  runtime?: RuntimeId;
}

type CreateCall = FakeCreateOpts;

function makeFakeManager(): { manager: SessionManager; calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  const manager = {
    async create(opts: FakeCreateOpts) {
      calls.push({ workdir: opts.workdir, name: opts.name, model: opts.model, runtime: opts.runtime });
      return {
        oakridgeSid: `sid-${calls.length}`,
        async writeInput(_input: string) {},
      };
    },
  } as unknown as SessionManager;
  return { manager, calls };
}

// Real artifact types per the stages table — kept accurate so future
// dispatch logic that branches on artifact type doesn't trip over the
// fixtures. Unknown stages fall back to a neutral spec→plan default.
const STAGE_ARTIFACT_TYPES: Record<
  string,
  { input: StageRow["input_artifact_type"]; output: StageRow["output_artifact_type"] }
> = {
  planner0: { input: "spec", output: "plan" },
  planner1: { input: "spec", output: "plan" },
  planner2: { input: "cohort", output: "brief" },
  planner2_batch: { input: "plan", output: "brief" },
  build: { input: "brief", output: "pr" },
};

function stage(name: string): StageRow {
  const artifacts = STAGE_ARTIFACT_TYPES[name] ?? { input: "spec", output: "plan" };
  return {
    name,
    prompt_template_path: `${name}.md`,
    input_artifact_type: artifacts.input,
    output_artifact_type: artifacts.output,
    gate: "none",
    default_backend: "kbbl_chat",
  };
}

const inputRef: InputRef = {
  type: "spec",
  id: "spec-1",
  workdir: "/tmp/repo",
  sessionName: "test-session",
};

describe("KbblChatBackend dispatch routes each stage to its intended model", () => {
  test("planner0 → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("planner0"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-7");
    expect(calls[0]?.runtime).toBe("claude-code");
  });

  test("planner1 → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("planner1"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-7");
  });

  test("planner2 → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("planner2"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-7");
  });

  test("planner2_batch → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("planner2_batch"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-7");
  });

  test("build → sonnet (the rule that got bypassed)", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("build"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
  });

  test("unknown stage without override → throws with actionable message", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await expect(backend.dispatch(stage("future-stage"), inputRef, "prompt")).rejects.toThrow(
      'No routing entry for stage "future-stage"'
    );
    expect(calls).toHaveLength(0);
  });
});

describe("KbblChatBackend dispatch config.runtime.stages overrides", () => {
  test("stage override takes precedence over STAGE_ROUTING", async () => {
    const { manager, calls } = makeFakeManager();
    const config = KbblConfigSchema.parse({
      runtime: { stages: { build: { runtime: "codex", model: "codex-model-x" } } },
    });
    const backend = createKbblChatBackend({ manager, config });
    await backend.dispatch(stage("build"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("codex-model-x");
    expect(calls[0]?.runtime).toBe("codex");
  });

  test("override applies to an otherwise-unrouted stage", async () => {
    const { manager, calls } = makeFakeManager();
    const config = KbblConfigSchema.parse({
      runtime: { stages: { "future-stage": { runtime: "claude-code", model: "some-model" } } },
    });
    const backend = createKbblChatBackend({ manager, config });
    await backend.dispatch(stage("future-stage"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("some-model");
    expect(calls[0]?.runtime).toBe("claude-code");
  });

  test("absent stages block leaves STAGE_ROUTING defaults intact", async () => {
    const { manager, calls } = makeFakeManager();
    const config = KbblConfigSchema.parse({});
    const backend = createKbblChatBackend({ manager, config });
    await backend.dispatch(stage("build"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
    expect(calls[0]?.runtime).toBe("claude-code");
  });
});
