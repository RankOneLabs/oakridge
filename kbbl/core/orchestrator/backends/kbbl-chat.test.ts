import { describe, expect, test } from "bun:test";
import { createKbblChatBackend } from "./kbbl-chat";
import type { InputRef, StageRow } from "./interface";
import type { SessionManager } from "../../session/session-manager";

interface CreateCall {
  workdir: string;
  name: string;
  model: string | null;
}

function makeFakeManager(): { manager: SessionManager; calls: CreateCall[] } {
  const calls: CreateCall[] = [];
  const manager = {
    async create(opts: { workdir: string; name: string; model: string | null }) {
      calls.push({ workdir: opts.workdir, name: opts.name, model: opts.model });
      return {
        oakridgeSid: `sid-${calls.length}`,
        async writeInput(_input: string) {},
      };
    },
  } as unknown as SessionManager;
  return { manager, calls };
}

function stage(name: string): StageRow {
  return {
    name,
    prompt_template_path: `${name}.md`,
    input_artifact_type: "spec",
    output_artifact_type: "plan",
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
