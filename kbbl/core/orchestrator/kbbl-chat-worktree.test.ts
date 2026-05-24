/**
 * Integration tests for KbblChatBackend's worktree dispatch behavior.
 *
 * These tests wire KbblChatBackend against a real SessionManager (noopSpawn)
 * and verify that build-stage dispatches always produce a worktree while
 * planner-stage dispatches do not — independent of the global flag.
 *
 * Kept separate from dispatch.test.ts to avoid paying that file's full
 * app/DB/prompt-fixture setup cost for lightweight worktree assertions.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KbblConfigSchema } from "../config";
import { SessionManager } from "../session/session-manager";
import type { Session, SpawnCmd } from "../session/session";
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

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  // cat reads stdin so the pipe stays open long enough for writeInput to succeed
  return { cmd: ["cat"], cwd: "/tmp", env: {} };
}

describe("KbblChatBackend dispatch worktree behavior", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-chat-wt-test-"));
    const p = Bun.spawn({
      cmd: ["mkdir", "-p",
        join(tmpRoot, "repo"),
        join(tmpRoot, "sessions"),
        join(tmpRoot, "worktrees"),
        join(tmpRoot, "handoffs"),
      ],
    });
    await p.exited;
    await gitInit(join(tmpRoot, "repo"));
  });

  afterEach(async () => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("build dispatch produces worktreePath !== null; planner1 dispatch produces worktreePath === null (global flag off)", async () => {
    const config = KbblConfigSchema.parse({ sessions: { worktree_per_session: false } });
    const manager = new SessionManager({
      sessionsDir: join(tmpRoot, "sessions"),
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir: join(tmpRoot, "worktrees"),
      buildSpawnCmd: noopSpawn,
      config,
    });

    const backend = createKbblChatBackend({ manager });

    const buildStage = {
      name: "build",
      prompt_template_path: "build.md",
      input_artifact_type: "brief" as const,
      output_artifact_type: "pr" as const,
      gate: "none" as const,
      default_backend: "kbbl_chat",
    };
    const plannerStage = {
      name: "planner1",
      prompt_template_path: "planner1.md",
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
    };

    // build stage: forceWorktree → worktreePath must be set
    const buildResult = await backend.dispatch(buildStage, inputRef, "build prompt");
    const buildSession = manager.get(buildResult.session_ref);
    if (!buildSession) throw new Error("expected build session to exist");
    expect(buildSession.worktreePath).not.toBeNull();
    if (!buildSession.worktreePath) throw new Error("expected build worktreePath to be set");
    expect(existsSync(buildSession.worktreePath)).toBe(true);

    // planner1 stage: no forceWorktree, global flag off → worktreePath must be null
    const plannerRef = { ...inputRef, type: "spec" as const };
    const plannerResult = await backend.dispatch(plannerStage, plannerRef, "planner prompt");
    const plannerSession = manager.get(plannerResult.session_ref);
    if (!plannerSession) throw new Error("expected planner session to exist");
    expect(plannerSession.worktreePath).toBeNull();

    await manager.endAll();
  });
});
