import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openTestDb } from "../db/test-db";
import { AcpSessionStore } from "../acp/store";
import type { AcpSessionStartSpec, KbblSessionId } from "../acp/types";
import { GitWorktreeProvider, parseDepthFromBranch } from "./service";

let tmpRoot: string;
let repoDir: string;
let store: AcpSessionStore;
let provider: GitWorktreeProvider;

async function gitInitRepo(dir: string): Promise<void> {
  const cmds: string[][] = [
    ["git", "-C", dir, "init", "-q", "-b", "main"],
    ["git", "-C", dir, "config", "user.email", "test@example.com"],
    ["git", "-C", dir, "config", "user.name", "test"],
    ["git", "-C", dir, "config", "commit.gpgsign", "false"],
    ["git", "-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
  ];
  for (const cmd of cmds) {
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
  }
}

const SID = "aaaaaaaa-bbbb-4ccc-8ddd-000000000001" as KbblSessionId;
const SID2 = "aaaaaaaa-bbbb-4ccc-8ddd-000000000002" as KbblSessionId;

function spec(overrides: Partial<AcpSessionStartSpec> = {}): AcpSessionStartSpec {
  return { initial_prompt: "x", workdir: repoDir, ...overrides };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-worktree-service-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(tmpRoot, "worktrees"), { recursive: true });
  await gitInitRepo(repoDir);
  store = new AcpSessionStore(openTestDb());
  provider = new GitWorktreeProvider({
    worktreesRoot: join(tmpRoot, "worktrees"),
    store,
  });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("parseDepthFromBranch", () => {
  test("reads the -r<n> suffix and defaults to 0", () => {
    expect(parseDepthFromBranch("kbbl/abc12345")).toBe(0);
    expect(parseDepthFromBranch("kbbl/abc12345-r3")).toBe(3);
    expect(parseDepthFromBranch(null)).toBe(0);
  });
});

describe("GitWorktreeProvider.resolve", () => {
  test("a fresh session gets its own worktree and branch", async () => {
    const resolved = await provider.resolve(SID, spec());
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.worktree_branch).toBe(`kbbl/${SID.slice(0, 8)}`);
    expect(existsSync(resolved.value.worktree_path)).toBe(true);
    expect(resolved.value.worktree_base_ref).toMatch(/^[0-9a-f]{40}$/);
  });

  test("a non-git workdir is a worktree_failed error, not a crash", async () => {
    const plainDir = join(tmpRoot, "plain");
    mkdirSync(plainDir);
    const resolved = await provider.resolve(SID, spec({ workdir: plainDir }));
    expect(!resolved.ok && resolved.error.code).toBe("worktree_failed");
    if (resolved.ok) return;
    expect(resolved.error.detail).toContain("not a git repository");
  });

  test("git failure detail discloses no server filesystem layout", async () => {
    // Same branch twice: the second create fails with git naming kbbl's
    // own worktrees root, which must not reach the caller (the server
    // binds beyond loopback).
    const identity = { branch_name: "cohort/x", worktree_subdir: "x" };
    const first = await provider.resolve(SID, spec({ worktree: identity }));
    expect(first.ok).toBe(true);
    const second = await provider.resolve(SID2, spec({ worktree: identity }));
    expect(!second.ok && second.error.code).toBe("worktree_failed");
    if (second.ok) return;
    expect(second.error.detail).not.toContain(tmpRoot);
    expect(second.error.detail).toMatch(/cohort\/x|<path>/);
  });

  test("inheritance cuts a NEW worktree from the parent's, with lineage", async () => {
    const parent = await provider.resolve(SID, spec());
    if (!parent.ok) throw new Error("parent worktree failed");
    store.insertSession({
      sid: SID,
      resumable_key: null,
      start_spec_hash: null,
      agent_profile: "fake",
      name: "parent",
      artifact_id: null,
      project_workdir: repoDir,
      worktree_path: parent.value.worktree_path,
      requested_model: null,
      requested_effort: null,
    });
    store.setWorktree(SID, {
      worktree_path: parent.value.worktree_path,
      worktree_branch: parent.value.worktree_branch,
      worktree_base_ref: parent.value.worktree_base_ref,
      parent_sid: null,
    });

    const child = await provider.resolve(
      SID2,
      spec({ inherit_worktree_from: SID }),
    );
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.value.worktree_path).not.toBe(parent.value.worktree_path);
    expect(child.value.worktree_branch).toBe(`kbbl/${SID2.slice(0, 8)}-r1`);
    expect(child.value.parent_sid).toBe(SID);
    expect(child.value.project_workdir).toBe(repoDir);
  });

  test("inheriting from an unknown (legacy) session fails with a clear reason", async () => {
    const resolved = await provider.resolve(
      SID,
      spec({ inherit_worktree_from: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
    );
    expect(!resolved.ok && resolved.error.code).toBe("worktree_failed");
    if (resolved.ok) return;
    expect(resolved.error.detail).toContain("legacy sessions cannot be inherited");
  });

  test("remove deletes the worktree and leaves the source repo alone", async () => {
    const resolved = await provider.resolve(SID, spec());
    if (!resolved.ok) throw new Error("worktree failed");
    await provider.remove({
      project_workdir: repoDir,
      worktree_path: resolved.value.worktree_path,
      worktree_branch: resolved.value.worktree_branch,
    });
    expect(existsSync(resolved.value.worktree_path)).toBe(false);
    expect(existsSync(repoDir)).toBe(true);
  });
});
