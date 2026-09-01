/**
 * Integration tests for KbblChatBackend's worktree dispatch behavior.
 *
 * Worktree-isolation is mandatory for every dispatched stage — there is no
 * opt-out. These tests wire KbblChatBackend against a real AcpSessionService
 * (fake ACP agent + real git worktree provider) and verify that both build
 * and planner stages produce a worktree, regardless of stage name.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeAcpTestService, type AcpTestHarness } from "../acp/test-harness";
import { createKbblChatBackend } from "./backends/kbbl-chat";

async function gitInit(cwd: string): Promise<void> {
  const cmds: string[][] = [
    ["git", "-C", cwd, "init", "-q", "-b", "main"],
    ["git", "-C", cwd, "config", "user.email", "test@example.com"],
    ["git", "-C", cwd, "config", "user.name", "test"],
    ["git", "-C", cwd, "config", "commit.gpgsign", "false"],
    ["git", "-C", cwd, "config", "tag.gpgsign", "false"],
    ["git", "-C", cwd, "commit", "--allow-empty", "-m", "init"],
  ];
  for (const cmd of cmds) {
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
  }
}

describe("KbblChatBackend dispatch worktree behavior", () => {
  let tmpRoot: string;
  let harness: AcpTestHarness;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-chat-wt-test-"));
    const p = Bun.spawn({
      cmd: ["mkdir", "-p",
        join(tmpRoot, "repo"),
        join(tmpRoot, "state"),
        join(tmpRoot, "worktrees"),
      ],
    });
    await p.exited;
    await gitInit(join(tmpRoot, "repo"));
    harness = makeAcpTestService({
      stateDir: join(tmpRoot, "state"),
      worktreesRoot: join(tmpRoot, "worktrees"),
    });
  });

  afterEach(async () => {
    await harness.service.shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("both build and planner dispatches produce a worktree", async () => {
    const backend = createKbblChatBackend({ acp: harness.service });

    const buildStage = {
      name: "build",
      prompt_template_path: "build.md",
      input_artifact_type: "brief" as const,
      output_artifact_type: "pr" as const,
      gate: "none" as const,
      default_backend: "kbbl_chat",
    };
    const plannerStage = {
      name: "plan_writer",
      prompt_template_path: "plan_writer.md",
      input_artifact_type: "spec" as const,
      output_artifact_type: "plan" as const,
      gate: "review_required" as const,
      default_backend: "kbbl_chat",
    };
    const inputRef = {
      type: "brief" as const,
      id: "fake-brief-id",
      workdir: join(tmpRoot, "repo"),
      sessionName: "test-session",
      modelSelection: { runtime: "claude-code" as const, model: "fake-small" },
    };

    // build stage: a real per-session worktree must exist
    const buildResult = await backend.dispatch(buildStage, inputRef, "build prompt");
    const buildSession = harness.service.getSession(buildResult.session_ref);
    if (!buildSession) throw new Error("expected build session to exist");
    expect(buildSession.worktree_branch).not.toBeNull();
    expect(buildSession.worktree_path).not.toBe(inputRef.workdir);
    expect(existsSync(buildSession.worktree_path)).toBe(true);

    // plan_writer stage: worktree must ALSO be set — no opt-out
    const plannerRef = {
      ...inputRef,
      type: "spec" as const,
      modelSelection: { runtime: "claude-code" as const, model: "fake-large" },
    };
    const plannerResult = await backend.dispatch(plannerStage, plannerRef, "planner prompt");
    const plannerSession = harness.service.getSession(plannerResult.session_ref);
    if (!plannerSession) throw new Error("expected planner session to exist");
    expect(plannerSession.worktree_branch).not.toBeNull();
    expect(plannerSession.worktree_path).not.toBe(inputRef.workdir);
    expect(existsSync(plannerSession.worktree_path)).toBe(true);
  });
});
