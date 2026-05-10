import { describe, expect, test } from "bun:test";

import { makeBuildSpawnCmd, type BuildSpawnCmdContext } from "./spawn";
import type { Session } from "../../core/session/session";
import type { SafirClient } from "../../core/safir/client";
import type { Task } from "../../core/safir/types";

const SAFIR_BASE = "http://localhost:7145";

function stubSafirClient(taskById: Record<number, Task>): SafirClient {
  return {
    async getTask(taskId: number): Promise<Task> {
      const t = taskById[taskId];
      if (!t) throw new Error(`stub: no task ${taskId}`);
      return t;
    },
    // The other methods are not exercised by these tests; throw if a
    // future test wires them and forgets to stub.
    listTasks: async () => { throw new Error("not stubbed"); },
    listHandoffsForTask: async () => { throw new Error("not stubbed"); },
    getHandoff: async () => { throw new Error("not stubbed"); },
    createRun: async () => { throw new Error("not stubbed"); },
    updateRun: async () => { throw new Error("not stubbed"); },
    abandonRun: async () => { throw new Error("not stubbed"); },
    createPhase: async () => { throw new Error("not stubbed"); },
    updatePhase: async () => { throw new Error("not stubbed"); },
    submitHandoff: async () => { throw new Error("not stubbed"); },
  };
}

function makeCtx(safirClient: SafirClient): BuildSpawnCmdContext {
  return {
    claudeBin: "claude",
    port: 3000,
    settingsPath: "/tmp/settings.json",
    safirClient,
    safirBaseUrl: SAFIR_BASE,
  };
}

function fakeSession(
  overrides: Partial<{
    model: string | null;
    parentCcSid: string | null;
    taskId: number | undefined;
    oakridgeSid: string;
  }>,
): Session {
  return {
    model: overrides.model ?? null,
    parentCcSid: overrides.parentCcSid ?? null,
    workdir: "/tmp",
    taskId: overrides.taskId,
    oakridgeSid: overrides.oakridgeSid ?? "sess-test-sid",
  } as unknown as Session;
}

describe("makeBuildSpawnCmd --model flag", () => {
  const buildSpawnCmd = makeBuildSpawnCmd(makeCtx(stubSafirClient({})));

  test("inserts --model when model is set", async () => {
    const session = fakeSession({ model: "claude-sonnet-4-6" });
    const { cmd } = await buildSpawnCmd(session);
    const modelIdx = cmd.indexOf("--model");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("claude-sonnet-4-6");
    expect(cmd.includes("--resume")).toBe(false);
  });

  test("omits --model entirely when model is null", async () => {
    const session = fakeSession({ model: null });
    const { cmd } = await buildSpawnCmd(session);
    expect(cmd.includes("--model")).toBe(false);
  });

  test("--model appears before --resume when both are set", async () => {
    const session = fakeSession({ model: "claude-opus-4-7", parentCcSid: "abc" });
    const { cmd } = await buildSpawnCmd(session);
    const modelIdx = cmd.indexOf("--model");
    const resumeIdx = cmd.indexOf("--resume");
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[modelIdx + 1]).toBe("claude-opus-4-7");
    expect(resumeIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[resumeIdx + 1]).toBe("abc");
    expect(cmd.includes("--fork-session")).toBe(true);
    expect(modelIdx).toBeLessThan(resumeIdx);
  });
});

describe("makeBuildSpawnCmd safir backlog flags", () => {
  test("ad-hoc session (no taskId): no allowlist, no system prompt", async () => {
    const buildSpawnCmd = makeBuildSpawnCmd(makeCtx(stubSafirClient({})));
    const session = fakeSession({ taskId: undefined });
    const { cmd } = await buildSpawnCmd(session);
    expect(cmd.includes("--allowedTools")).toBe(false);
    expect(cmd.includes("--append-system-prompt")).toBe(false);
  });

  test("taskId-bound session with successful lookup: allowlist + prompt both present", async () => {
    const safir = stubSafirClient({
      99: { id: 99, project_id: "r1l", parent_id: null, title: "t", status: "active" },
    });
    const buildSpawnCmd = makeBuildSpawnCmd(makeCtx(safir));
    const session = fakeSession({ taskId: 99, oakridgeSid: "sess-xyz" });
    const { cmd } = await buildSpawnCmd(session);

    const allowIdx = cmd.indexOf("--allowedTools");
    expect(allowIdx).toBeGreaterThanOrEqual(0);
    expect(cmd[allowIdx + 1]).toBe(
      `Bash(curl -s -X POST ${SAFIR_BASE}/tasks:*)`,
    );

    const promptIdx = cmd.indexOf("--append-system-prompt");
    expect(promptIdx).toBeGreaterThanOrEqual(0);
    const block = cmd[promptIdx + 1]!;
    expect(block).toContain("safir task #99");
    expect(block).toContain("project `r1l`");
    expect(block).toContain("kbbl session sess-xyz");
    expect(block).toContain('"parent_id":99');
    expect(block).toContain('"project_id":"r1l"');
  });

  test("taskId-bound session with failed lookup: no allowlist, no prompt, no throw", async () => {
    // The default stub throws when asked for any unknown task id.
    const buildSpawnCmd = makeBuildSpawnCmd(makeCtx(stubSafirClient({})));
    const session = fakeSession({ taskId: 404 });
    const { cmd } = await buildSpawnCmd(session);
    expect(cmd.includes("--allowedTools")).toBe(false);
    expect(cmd.includes("--append-system-prompt")).toBe(false);
  });

  test("emits exactly one --allowedTools flag (single pattern)", async () => {
    const safir = stubSafirClient({
      1: { id: 1, project_id: "p", parent_id: null, title: "t", status: "active" },
    });
    const buildSpawnCmd = makeBuildSpawnCmd(makeCtx(safir));
    const { cmd } = await buildSpawnCmd(fakeSession({ taskId: 1 }));
    const count = cmd.filter((s) => s === "--allowedTools").length;
    expect(count).toBe(1);
  });
});
