/**
 * Route-level lifecycle behavior for the ACP-backed session surface:
 * listing in the legacy snapshot projection, resume-as-worktree-inheritance
 * (§17.3), and purge. Static model/effort allowlist tests died with the
 * provider adapters — §12 moved that validation into the session, covered
 * by sessions.contract.test.ts.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountSessionsRoutes } from "./sessions";
import { makeAcpTestService, type AcpTestHarness } from "../../acp/test-harness";
import type { SessionManager } from "../../session/session-manager";

let tmpRoot: string;
let repoDir: string;
let harness: AcpTestHarness;

async function gitInitRepo(dir: string): Promise<void> {
  const cmds: string[][] = [
    ["git", "-C", dir, "init", "-q", "-b", "main"],
    ["git", "-C", dir, "config", "user.email", "test@example.com"],
    ["git", "-C", dir, "config", "user.name", "test"],
    ["git", "-C", dir, "config", "commit.gpgsign", "false"],
    ["git", "-C", dir, "config", "tag.gpgsign", "false"],
    ["git", "-C", dir, "commit", "--allow-empty", "-q", "-m", "init"],
  ];
  for (const cmd of cmds) {
    const p = Bun.spawn({ cmd, stdout: "pipe", stderr: "pipe" });
    const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
    if (code !== 0) throw new Error(`${cmd.join(" ")} failed (exit ${code}): ${stderr}`);
  }
}

const stubManager = {
  listSnapshots: () => [],
  listArchivedSnapshots: async () => [],
  listByArtifact: () => [],
  remove: async () => false,
} as unknown as SessionManager;

function makeApp(): Hono {
  const app = new Hono();
  mountSessionsRoutes(app, {
    acp: harness.service,
    manager: stubManager,
    defaultWorkdir: repoDir,
  });
  return app;
}

async function postSessions(app: Hono, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.request("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-sessions-model-test-"));
  repoDir = join(tmpRoot, "repo");
  await mkdir(join(tmpRoot, "worktrees"), { recursive: true });
  await mkdir(join(tmpRoot, "state"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  await gitInitRepo(repoDir);
  harness = makeAcpTestService({
    stateDir: join(tmpRoot, "state"),
    worktreesRoot: join(tmpRoot, "worktrees"),
  });
});

afterEach(async () => {
  await harness.service.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /sessions", () => {
  test("lists ACP sessions in the legacy snapshot projection", async () => {
    const app = makeApp();
    const created = await postSessions(app, { workdir: repoDir, name: "one" });
    expect(created.status).toBe(200);

    const res = await app.request("/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<Record<string, unknown>> };
    expect(body.sessions).toHaveLength(1);
    const snapshot = body.sessions[0]!;
    expect(snapshot.sid).toBe(created.body.sid);
    expect(snapshot.name).toBe("one");
    // Legacy vocabulary: an idle ACP session reads as "live".
    expect(snapshot.status).toBe("live");
    expect(snapshot.runtimeId).toBe("claude-code");
    expect(typeof snapshot.lastActivityTs).toBe("string");
  });

  test("artifact-tagged sessions surface through /artifacts/:id/sessions", async () => {
    const app = makeApp();
    await postSessions(app, { workdir: repoDir, artifact_id: "artifact-7" });
    await postSessions(app, { workdir: repoDir });

    const res = await app.request("/artifacts/artifact-7/sessions");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ artifactId: string | null }> };
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]!.artifactId).toBe("artifact-7");
  });
});

describe("POST /sessions resume_from (§17.3: worktree inheritance)", () => {
  test("the child runs in a fresh worktree cut from the parent's, with lineage recorded", async () => {
    const app = makeApp();
    const parent = await postSessions(app, { workdir: repoDir, name: "parent" });
    expect(parent.status).toBe(200);
    const parentSid = parent.body.sid as string;
    const parentWorktree = parent.body.worktreePath as string;

    const child = await postSessions(app, { resume_from: parentSid, name: "child" });
    expect(child.status).toBe(200);
    expect(child.body.worktreePath).not.toBe(parentWorktree);
    expect(child.body.worktreeBranch).toMatch(/-r1$/);
    expect(child.body.parentOakridgeSid ?? null).toBeNull(); // legacy field stays null
    const childRow = harness.store.getSession(
      child.body.sid as never,
    );
    expect(childRow?.parent_sid).toBe(parentSid as never);
    // Project identity points at the original repo, not the parent worktree.
    expect(childRow?.project_workdir).toBe(repoDir);
  });

  test("resume_from an unknown session is a 404", async () => {
    const app = makeApp();
    const res = await postSessions(app, { resume_from: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    expect(res.status).toBe(404);
  });
});

describe("DELETE /sessions/:sid?purge=true", () => {
  test("purge removes the worktree and the session row", async () => {
    const app = makeApp();
    const created = await postSessions(app, { workdir: repoDir });
    const sid = created.body.sid as string;
    const worktreePath = created.body.worktreePath as string;
    expect(existsSync(worktreePath)).toBe(true);

    const res = await app.request(`/sessions/${sid}?purge=true`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: true });
    expect(existsSync(worktreePath)).toBe(false);
    expect(harness.service.getSession(sid)).toBeNull();
  });

  test("plain close retains the session row and worktree", async () => {
    const app = makeApp();
    const created = await postSessions(app, { workdir: repoDir });
    const sid = created.body.sid as string;

    const res = await app.request(`/sessions/${sid}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const after = harness.service.getSession(sid);
    expect(after?.status).toBe("ended");
    expect(existsSync(created.body.worktreePath as string)).toBe(true);
  });
});
