import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKbblChatBackend, type KbblChatSessionPort } from "./kbbl-chat";
import type { InputRef, StageRow } from "./interface";
import type { AcpSessionSnapshot, AcpSessionStartSpec } from "../../acp/types";
import { ok } from "../../acp/types";
import { makeAcpTestService, type AcpTestHarness } from "../../acp/test-harness";
import { ensureEpicBranchExists } from "./dispatcher";

function makeFakePort(): { port: KbblChatSessionPort; calls: AcpSessionStartSpec[] } {
  const calls: AcpSessionStartSpec[] = [];
  const port: KbblChatSessionPort = {
    async createSession(spec) {
      calls.push(spec);
      return ok({ sid: `sid-${calls.length}` } as unknown as AcpSessionSnapshot);
    },
    getSession() {
      return null;
    },
  };
  return { port, calls };
}

// Real artifact types per the stages table — kept accurate so future
// dispatch logic that branches on artifact type doesn't trip over the
// fixtures. Unknown stages fall back to a neutral spec→plan default.
const STAGE_ARTIFACT_TYPES: Record<
  string,
  { input: StageRow["input_artifact_type"]; output: StageRow["output_artifact_type"] }
> = {
  spec_analyzer: { input: "spec", output: "discrepancies" },
  plan_writer:   { input: "spec", output: "plan" },
  brief_writer:  { input: "plan", output: "brief" },
  assessor:      { input: "plan", output: "assessment" },
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
  modelSelection: { runtime: "claude-code", model: "claude-opus-4-8" },
};

const CLAUDE_PLANNER_SELECTION = { runtime: "claude-code", model: "claude-opus-4-8" } as const;
const CLAUDE_WORKER_SELECTION = { runtime: "claude-code", model: "claude-sonnet-4-6" } as const;
const CODEX_PLANNER_SELECTION = { runtime: "codex", model: "gpt-5.6-sol" } as const;
const CODEX_WORKER_SELECTION = { runtime: "codex", model: "gpt-5.6-luna" } as const;
// The fake ACP agent exposes fake-small/fake-large as its model options;
// integration dispatches must request one of those (§12 resolution is real).
const FAKE_WORKER_SELECTION = { runtime: "claude-code", model: "fake-small" } as const;

describe("KbblChatBackend dispatch routes explicit model selections", () => {
  test("spec_analyzer → planner selection", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(stage("spec_analyzer"), { ...inputRef, modelSelection: CLAUDE_PLANNER_SELECTION }, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
    expect(calls[0]?.runtime).toBe("claude-code");
  });

  test("plan_writer → planner selection", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(stage("plan_writer"), { ...inputRef, modelSelection: CLAUDE_PLANNER_SELECTION }, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
  });

  test("brief_writer → planner selection", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(stage("brief_writer"), { ...inputRef, modelSelection: CLAUDE_PLANNER_SELECTION }, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
  });

  test("assessor → planner selection", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(stage("assessor"), { ...inputRef, modelSelection: CLAUDE_PLANNER_SELECTION }, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
    expect(calls[0]?.runtime).toBe("claude-code");
  });

  test("build → worker selection", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(stage("build"), { ...inputRef, modelSelection: CLAUDE_WORKER_SELECTION }, "prompt");
    expect(calls[0]?.model).toBe("claude-sonnet-4-6");
  });

  test("codex flow routes planner stages to gpt-5.6-sol", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(
      stage("plan_writer"),
      { ...inputRef, modelSelection: CODEX_PLANNER_SELECTION },
      "prompt",
    );
    expect(calls[0]?.model).toBe("gpt-5.6-sol");
    expect(calls[0]?.runtime).toBe("codex");
  });

  test("codex flow routes build to gpt-5.6-luna", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(
      stage("build"),
      { ...inputRef, modelSelection: CODEX_WORKER_SELECTION },
      "prompt",
    );
    expect(calls[0]?.model).toBe("gpt-5.6-luna");
    expect(calls[0]?.runtime).toBe("codex");
  });

  test("unknown stage still routes when dispatcher passes explicit modelSelection", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(stage("future-stage"), { ...inputRef, modelSelection: CODEX_PLANNER_SELECTION }, "prompt");
    expect(calls[0]?.model).toBe("gpt-5.6-sol");
    expect(calls[0]?.runtime).toBe("codex");
  });

  test("the rendered prompt travels as the initial turn", async () => {
    const { port, calls } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await backend.dispatch(stage("build"), { ...inputRef, modelSelection: CLAUDE_WORKER_SELECTION }, "the rendered prompt");
    expect(calls[0]?.initial_prompt).toBe("the rendered prompt");
  });

  test("missing modelSelection is refused", async () => {
    const { port } = makeFakePort();
    const backend = createKbblChatBackend({ acp: port });
    await expect(
      backend.dispatch(stage("build"), { ...inputRef, modelSelection: undefined } as unknown as InputRef, "prompt"),
    ).rejects.toThrow(/No routing entry/);
  });
});

// ---- Integration tests: worktreeIdentity flows through KbblChatBackend ----

async function runCmd(cmd: string[]): Promise<void> {
  const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
}

async function getRevParse(workdir: string, ref: string): Promise<string> {
  const p = Bun.spawn({ cmd: ["git", "-C", workdir, "rev-parse", ref], stdout: "pipe", stderr: "pipe" });
  const [stdout, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  if (code !== 0) throw new Error(`git rev-parse ${ref} failed`);
  return stdout.trim();
}

describe("KbblChatBackend worktreeIdentity integration", () => {
  let tmpRoot: string;
  let workdir: string;
  let harness: AcpTestHarness;

  const EPIC_SLUG = "test_epic";
  const COHORT_SLUG = "1-test_cohort";
  const EPIC_BRANCH = `epic/${EPIC_SLUG}`;

  const buildStage: StageRow = {
    name: "build",
    prompt_template_path: "build.md",
    input_artifact_type: "brief",
    output_artifact_type: "pr",
    gate: "none",
    default_backend: "kbbl_chat",
  };

  beforeEach(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-chat-identity-"));
    const originPath = join(tmpRoot, "origin");
    workdir = join(tmpRoot, "workdir");
    const dirs = Bun.spawn({
      cmd: ["mkdir", "-p", join(tmpRoot, "state"), join(tmpRoot, "worktrees")],
    });
    await dirs.exited;
    await runCmd(["git", "init", "--bare", "-b", "main", originPath]);
    await runCmd(["git", "clone", originPath, workdir]);
    await runCmd(["git", "-C", workdir, "config", "user.email", "test@example.com"]);
    await runCmd(["git", "-C", workdir, "config", "user.name", "test"]);
    await runCmd(["git", "-C", workdir, "config", "commit.gpgsign", "false"]);
    await runCmd(["git", "-C", workdir, "commit", "--allow-empty", "-m", "init"]);
    await runCmd(["git", "-C", workdir, "push", "origin", "main"]);

    harness = makeAcpTestService({
      stateDir: join(tmpRoot, "state"),
      worktreesRoot: join(tmpRoot, "worktrees"),
    });
  });

  afterEach(async () => {
    await harness.service.shutdown();
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  test("Test A: pre-seeded epic branch → session lands on slug branch with correct base sha", async () => {
    // Pre-seed origin/epic/<slug>
    await runCmd(["git", "-C", workdir, "push", "origin", `main:refs/heads/${EPIC_BRANCH}`]);
    await runCmd(["git", "-C", workdir, "fetch", "origin", EPIC_BRANCH]);

    const expectedSha = await getRevParse(workdir, `origin/${EPIC_BRANCH}`);

    const ref: InputRef = {
      type: "brief",
      id: "fake-brief",
      workdir,
      sessionName: "test-session",
      worktreeIdentity: { epicSlug: EPIC_SLUG, cohortSlug: COHORT_SLUG, epicBranch: EPIC_BRANCH },
      modelSelection: FAKE_WORKER_SELECTION,
    };
    const backend = createKbblChatBackend({ acp: harness.service });
    const { session_ref } = await backend.dispatch(buildStage, ref, "prompt");

    const session = harness.service.getSession(session_ref);
    if (!session) throw new Error("session not found");
    expect(session.worktree_branch).toBe(`cohort/${EPIC_SLUG}/${COHORT_SLUG}`);
    expect(session.worktree_base_ref).toBe(expectedSha);
  });

  test("Test B: absent epic branch → seed it with git, session lands on slug branch", async () => {
    // Confirm branch absent before seeding
    const lsBefore = Bun.spawn({
      cmd: ["git", "-C", workdir, "ls-remote", "origin", `refs/heads/${EPIC_BRANCH}`],
      stdout: "pipe", stderr: "pipe",
    });
    const [lsOut] = await Promise.all([new Response(lsBefore.stdout).text(), lsBefore.exited]);
    expect(lsOut.trim()).toBe("");

    // Seed the branch via git (mirror what ensureEpicBranchExists does internally)
    await runCmd(["git", "-C", workdir, "push", "origin", `main:refs/heads/${EPIC_BRANCH}`]);
    await runCmd(["git", "-C", workdir, "fetch", "origin", EPIC_BRANCH]);

    // Dispatch with worktreeIdentity — branch is now seeded + local tracking ref updated
    const expectedSha = await getRevParse(workdir, `origin/${EPIC_BRANCH}`);
    const ref: InputRef = {
      type: "brief",
      id: "fake-brief",
      workdir,
      sessionName: "test-session",
      worktreeIdentity: { epicSlug: EPIC_SLUG, cohortSlug: COHORT_SLUG, epicBranch: EPIC_BRANCH },
      modelSelection: FAKE_WORKER_SELECTION,
    };
    const backend = createKbblChatBackend({ acp: harness.service });
    const { session_ref } = await backend.dispatch(buildStage, ref, "prompt");

    const session = harness.service.getSession(session_ref);
    if (!session) throw new Error("session not found");
    expect(session.worktree_branch).toBe(`cohort/${EPIC_SLUG}/${COHORT_SLUG}`);
    expect(session.worktree_base_ref).toBe(expectedSha);
  });

  test("absent epic branch is seeded from latest remote main, not stale local main", async () => {
    const updater = join(tmpRoot, "updater");
    await runCmd(["git", "clone", join(tmpRoot, "origin"), updater]);
    await runCmd(["git", "-C", updater, "config", "user.email", "test@example.com"]);
    await runCmd(["git", "-C", updater, "config", "user.name", "test"]);
    await runCmd(["git", "-C", updater, "config", "commit.gpgsign", "false"]);
    await runCmd(["git", "-C", updater, "commit", "--allow-empty", "-m", "remote ahead"]);
    await runCmd(["git", "-C", updater, "push", "origin", "main"]);

    const staleLocalMain = await getRevParse(workdir, "main");
    const latestRemoteMain = await getRevParse(updater, "main");
    expect(staleLocalMain).not.toBe(latestRemoteMain);

    await ensureEpicBranchExists(EPIC_BRANCH, workdir);

    expect(await getRevParse(workdir, `origin/${EPIC_BRANCH}`)).toBe(latestRemoteMain);
  });
});
