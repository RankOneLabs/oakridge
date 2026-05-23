import { describe, expect, test } from "bun:test";
import { createKbblChatBackend } from "./kbbl-chat";
import type { InputRef, StageRow } from "./interface";
import type { SessionManager } from "../../session/session-manager";

interface FakeCreateOpts {
  workdir: string;
  name: string;
  model: string | null;
}

type CreateCall = FakeCreateOpts;

function makeFakeManager(): { manager: SessionManager; calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  const manager = {
    async create(opts: FakeCreateOpts) {
      calls.push({ workdir: opts.workdir, name: opts.name, model: opts.model });
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
  planner1: { input: "spec", output: "plan" },
  planner2: { input: "cohort", output: "brief" },
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

  test("build → sonnet (the rule that got bypassed)", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("build"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
  });

  test("unknown stage → null (falls back to CC default, not silently wrong)", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("future-stage"), inputRef, "prompt");
    expect(calls[0]?.model).toBeNull();
  });
});
