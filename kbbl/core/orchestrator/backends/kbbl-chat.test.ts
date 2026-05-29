import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createKbblChatBackend, resolveStageRouting } from "./kbbl-chat";
import type { InputRef, StageRow } from "./interface";
import { SessionManager } from "../../session/session-manager";
import type { KbblConfig } from "../../config";
import { KbblConfigSchema } from "../../config";
import type { RuntimeId } from "../../runtime";
import type { Session, SpawnCmd } from "../../session/session";

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
};

describe("KbblChatBackend dispatch routes each stage to its intended model", () => {
  test("spec_analyzer → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("spec_analyzer"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
    expect(calls[0]?.runtime).toBe("claude-code");
  });

  test("plan_writer → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("plan_writer"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
  });

  test("brief_writer → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("brief_writer"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
  });

  test("assessor → opus", async () => {
    const { manager, calls } = makeFakeManager();
    const backend = createKbblChatBackend({ manager });
    await backend.dispatch(stage("assessor"), inputRef, "prompt");
    expect(calls[0]?.model).toBe("claude-opus-4-8");
    expect(calls[0]?.runtime).toBe("claude-code");
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

describe("resolveStageRouting — three-tier precedence", () => {
  test("override beats config.stages beats STAGE_ROUTING", () => {
    const config = KbblConfigSchema.parse({
      runtime: { stages: { build: { runtime: "codex", model: "config-model" } } },
    });
    const override = { runtime: "claude-code" as RuntimeId, model: "override-model" };
    const result = resolveStageRouting("build", config, override);
    expect(result?.model).toBe("override-model");
    expect(result?.runtime).toBe("claude-code");
  });

  test("config.stages beats STAGE_ROUTING when no override", () => {
    const config = KbblConfigSchema.parse({
      runtime: { stages: { build: { runtime: "codex", model: "config-model" } } },
    });
    const result = resolveStageRouting("build", config);
    expect(result?.model).toBe("config-model");
    expect(result?.runtime).toBe("codex");
  });

  test("STAGE_ROUTING when no override and no config.stages entry", () => {
    const result = resolveStageRouting("build", undefined);
    expect(result?.model).toBe("claude-sonnet-4-6");
    expect(result?.runtime).toBe("claude-code");
  });

  test("planner stages resolve to opus via STAGE_ROUTING", () => {
    for (const stageName of ["spec_analyzer", "plan_writer", "brief_writer", "assessor"]) {
      const result = resolveStageRouting(stageName, undefined);
      expect(result?.model).toBe("claude-opus-4-8");
      expect(result?.runtime).toBe("claude-code");
    }
  });

  test("returns null for unknown stage with no tier covering it", () => {
    const result = resolveStageRouting("unknown-stage", undefined);
    expect(result).toBeNull();
  });

  test("config.stages covers an otherwise-unrouted stage", () => {
    const config = KbblConfigSchema.parse({
      runtime: { stages: { "future-stage": { runtime: "claude-code", model: "some-model" } } },
    });
    const result = resolveStageRouting("future-stage", config);
    expect(result?.model).toBe("some-model");
    expect(result?.runtime).toBe("claude-code");
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

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  return { cmd: ["cat"], cwd: "/tmp", env: {} };
}

describe("KbblChatBackend worktreeIdentity integration", () => {
  let tmpRoot: string;
  let workdir: string;
  let manager: SessionManager;

  const EPIC_SLUG = "test_epic";
  const COHORT_SLUG = "cohort-1-test_cohort";
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
      cmd: ["mkdir", "-p", join(tmpRoot, "sessions"), join(tmpRoot, "worktrees"), join(tmpRoot, "handoffs")],
    });
    await dirs.exited;
    await runCmd(["git", "init", "--bare", "-b", "main", originPath]);
    await runCmd(["git", "clone", originPath, workdir]);
    await runCmd(["git", "-C", workdir, "config", "user.email", "test@example.com"]);
    await runCmd(["git", "-C", workdir, "config", "user.name", "test"]);
    await runCmd(["git", "-C", workdir, "config", "commit.gpgsign", "false"]);
    await runCmd(["git", "-C", workdir, "commit", "--allow-empty", "-m", "init"]);
    await runCmd(["git", "-C", workdir, "push", "origin", "main"]);

    const config = KbblConfigSchema.parse({}) as KbblConfig;
    manager = new SessionManager({
      sessionsDir: join(tmpRoot, "sessions"),
      handoffsDir: join(tmpRoot, "handoffs"),
      worktreesDir: join(tmpRoot, "worktrees"),
      buildSpawnCmd: noopSpawn,
      config,
    });
  });

  afterEach(async () => {
    await manager.endAll();
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
    };
    const backend = createKbblChatBackend({ manager });
    const { session_ref } = await backend.dispatch(buildStage, ref, "prompt");

    const session = manager.get(session_ref);
    if (!session) throw new Error("session not found");
    expect(session.worktreeBranch).toBe(`${EPIC_BRANCH}/${COHORT_SLUG}`);
    expect(session.worktreeBaseRef).toBe(expectedSha);
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

    // Confirm seeding worked
    const lsAfter = Bun.spawn({
      cmd: ["git", "-C", workdir, "ls-remote", "origin", `refs/heads/${EPIC_BRANCH}`],
      stdout: "pipe", stderr: "pipe",
    });
    const [lsAfterOut] = await Promise.all([new Response(lsAfter.stdout).text(), lsAfter.exited]);
    expect(lsAfterOut.trim()).not.toBe("");

    // Dispatch with worktreeIdentity — branch is now seeded + local tracking ref updated
    const expectedSha = await getRevParse(workdir, `origin/${EPIC_BRANCH}`);
    const ref: InputRef = {
      type: "brief",
      id: "fake-brief",
      workdir,
      sessionName: "test-session",
      worktreeIdentity: { epicSlug: EPIC_SLUG, cohortSlug: COHORT_SLUG, epicBranch: EPIC_BRANCH },
    };
    const backend = createKbblChatBackend({ manager });
    const { session_ref } = await backend.dispatch(buildStage, ref, "prompt");

    const session = manager.get(session_ref);
    if (!session) throw new Error("session not found");
    expect(session.worktreeBranch).toBe(`${EPIC_BRANCH}/${COHORT_SLUG}`);
    expect(session.worktreeBaseRef).toBe(expectedSha);
  });
});
