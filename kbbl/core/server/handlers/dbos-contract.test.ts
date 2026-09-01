/**
 * The DBOS <-> kbbl HTTP contract, proven end to end (§24.3): the REAL
 * `KbblExecutorAdapter` from oakridge-dbos driving the real session routes
 * over HTTP, backed by the real AcpSessionService, real git worktrees, and
 * a real fake-agent child process. This is the suite that says replacing
 * the runtime did not alter Oakridge orchestration semantics.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { KbblExecutorAdapter } from "../../../../oakridge-dbos/src/adapters/kbbl";
import type {
  ExecutionRequest,
  ExternalExecutionReference,
} from "../../../../oakridge-dbos/src/domain/execution";
import type {
  ExecutionId,
  ExecutorOperationId,
} from "../../../../oakridge-dbos/src/domain/primitives";

import { mountSessionsRoutes } from "./sessions";
import { makeAcpTestService, type AcpTestHarness } from "../../acp/test-harness";
import type { SessionManager } from "../../session/session-manager";
import type { KbblSessionId, TurnKey } from "../../acp/types";

let tmpRoot: string;
let repoDir: string;
let harness: AcpTestHarness;
let server: ReturnType<typeof Bun.serve>;
let adapter: KbblExecutorAdapter;

const stubManager = {
  listSnapshots: () => [],
  listArchivedSnapshots: async () => [],
  listByArtifact: () => [],
  remove: async () => false,
} as unknown as SessionManager;

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

function makeRequest(overrides: {
  execution_id: string;
  runtime?: string;
  prompt?: string;
  workdir?: string;
  worktree?: { branchName: string; worktreeSubdir: string; baseRef?: string };
  workspace_source?: { execution_id: string; external_reference: ExternalExecutionReference };
}): ExecutionRequest {
  return {
    execution_id: overrides.execution_id,
    stage_instance_id: "stage-1",
    unit_id: "0",
    executor_type: "delegated_session",
    resolved_config: {
      runtime: (overrides.runtime ?? "claude-code") as "claude-code" | "codex",
      rendered_prompt: overrides.prompt ?? "analyze the spec",
      workdir: overrides.workdir ?? repoDir,
      session_name: `contract-${overrides.execution_id}`,
      ...(overrides.worktree ? { worktree: overrides.worktree } : {}),
    },
    inputs: [],
    declared_outputs: [],
    expected_artifacts: [],
    ...(overrides.workspace_source
      ? {
          workspace_source: {
            execution_id: overrides.workspace_source.execution_id as ExecutionId,
            external_reference: overrides.workspace_source.external_reference,
          },
        }
      : {}),
  } as unknown as ExecutionRequest;
}

function makeHarness(behavior?: string, delayMs?: number): void {
  harness = makeAcpTestService({
    stateDir: join(tmpRoot, "state"),
    worktreesRoot: join(tmpRoot, "worktrees"),
    ...(behavior ? { behavior } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
  });
  const app = new Hono();
  mountSessionsRoutes(app, {
    acp: harness.service,
    manager: stubManager,
    defaultWorkdir: repoDir,
  });
  server = Bun.serve({ port: 0, idleTimeout: 60, fetch: app.fetch });
  adapter = new KbblExecutorAdapter({
    base_url: `http://127.0.0.1:${server.port}`,
    executor_function_identity: "contract-test",
    observe_wait_ms: 2_000,
  });
}

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-dbos-contract-"));
  repoDir = join(tmpRoot, "repo");
  await mkdir(join(tmpRoot, "worktrees"), { recursive: true });
  await mkdir(join(tmpRoot, "state"), { recursive: true });
  mkdirSync(repoDir, { recursive: true });
  await gitInitRepo(repoDir);
});

afterEach(async () => {
  server?.stop(true);
  await harness?.service.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test("start_or_attach → observe_terminal succeeds through a real agent turn", async () => {
  makeHarness();
  const request = makeRequest({ execution_id: "exec-1" });
  const reference = await adapter.start_or_attach(request, "op-1" as ExecutorOperationId);
  expect(reference.kind).toBe("kbbl_session");
  if (reference.kind !== "kbbl_session") return;
  // worktree_base_sha reaches DBOS (§17.1).
  expect(reference.worktree_base_sha).toMatch(/^[0-9a-f]{40}$/);

  const deadline = Date.now() + 15_000;
  for (;;) {
    const observed = await adapter.observe_terminal("exec-1" as ExecutionId, reference);
    if (observed.kind === "terminal") {
      expect(observed.observation.kind).toBe("succeeded");
      return;
    }
    if (Date.now() > deadline) throw new Error("never terminal");
  }
}, 20000);

test("start_or_attach is idempotent per operation id — one session, same sid", async () => {
  makeHarness();
  const request = makeRequest({ execution_id: "exec-2" });
  const first = await adapter.start_or_attach(request, "op-2" as ExecutorOperationId);
  const second = await adapter.start_or_attach(request, "op-2" as ExecutorOperationId);
  if (first.kind !== "kbbl_session" || second.kind !== "kbbl_session") throw new Error("expected sessions");
  expect(second.session_id).toBe(first.session_id);
  expect(harness.store.listSessions()).toHaveLength(1);
});

test("deliver_input lands durably and runs as a collaboration turn", async () => {
  makeHarness();
  const request = makeRequest({ execution_id: "exec-3" });
  const reference = await adapter.start_or_attach(request, "op-3" as ExecutorOperationId);
  if (reference.kind !== "kbbl_session") throw new Error("expected session");

  await adapter.deliver_input("exec-3" as ExecutionId, "delivery-1", "revise the build", reference);
  // Redelivery with the same key is accepted (idempotent), a different body conflicts.
  await adapter.deliver_input("exec-3" as ExecutionId, "delivery-1", "revise the build", reference);
  await expect(
    adapter.deliver_input("exec-3" as ExecutionId, "delivery-1", "different text", reference),
  ).rejects.toThrow(/409/);

  const sid = reference.session_id as KbblSessionId;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const turn = harness.store.getTurn(sid, "delivery-1" as TurnKey);
    if (turn?.status === "succeeded") break;
    if (Date.now() > deadline) throw new Error("collaboration turn never ran");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}, 20000);

test("cancel_or_fence fences the session and a later observation reads cancelled", async () => {
  // Delayed agent so the fence provably lands while the initial turn is
  // still running — a finished turn would (correctly) observe as success.
  makeHarness("delayed", 8_000);
  const request = makeRequest({ execution_id: "exec-4" });
  const reference = await adapter.start_or_attach(request, "op-4" as ExecutorOperationId);
  if (reference.kind !== "kbbl_session") throw new Error("expected session");

  await adapter.cancel_or_fence("exec-4" as ExecutionId, reference);
  const row = harness.store.getSession(reference.session_id as KbblSessionId);
  expect(row?.status).toBe("fenced");
  expect(row?.fenced_by).toBe("exec-4");

  const observed = await adapter.observe_terminal("exec-4" as ExecutionId, reference);
  expect(observed.kind).toBe("terminal");
  if (observed.kind !== "terminal") return;
  expect(observed.observation.kind).toBe("cancelled");
}, 20000);

test("a mid-prompt agent crash reads as failure, never success", async () => {
  makeHarness("crash_mid_prompt");
  const request = makeRequest({ execution_id: "exec-5" });
  const reference = await adapter.start_or_attach(request, "op-5" as ExecutorOperationId);
  if (reference.kind !== "kbbl_session") throw new Error("expected session");

  const deadline = Date.now() + 15_000;
  for (;;) {
    const observed = await adapter.observe_terminal("exec-5" as ExecutionId, reference);
    if (observed.kind === "terminal") {
      expect(observed.observation.kind).toBe("failed");
      return;
    }
    if (Date.now() > deadline) throw new Error("never terminal");
  }
}, 20000);

test("a slow turn observes as pending, not terminal", async () => {
  makeHarness();
  // Rebuild against a delayed agent: the initial turn outlives the poll.
  server.stop(true);
  await harness.service.shutdown();
  harness = makeAcpTestService({
    stateDir: join(tmpRoot, "state"),
    worktreesRoot: join(tmpRoot, "worktrees"),
    behavior: "delayed",
    delayMs: 10_000,
  });
  const app = new Hono();
  mountSessionsRoutes(app, {
    acp: harness.service,
    manager: stubManager,
    defaultWorkdir: repoDir,
  });
  server = Bun.serve({ port: 0, idleTimeout: 60, fetch: app.fetch });
  adapter = new KbblExecutorAdapter({
    base_url: `http://127.0.0.1:${server.port}`,
    executor_function_identity: "contract-test",
    observe_wait_ms: 500,
  });

  const request = makeRequest({ execution_id: "exec-6" });
  const reference = await adapter.start_or_attach(request, "op-6" as ExecutorOperationId);
  if (reference.kind !== "kbbl_session") throw new Error("expected session");
  const observed = await adapter.observe_terminal("exec-6" as ExecutionId, reference);
  expect(observed.kind).toBe("pending");
}, 20000);

test("a DBOS worktree identity produces the requested branch from the requested base", async () => {
  makeHarness();
  // A bare branch name would be rewritten to origin/<branch> by the
  // adapter (Oakridge bases always mean the remote branch) and this repo
  // has no remote; a 40-char sha passes through verbatim.
  const head = Bun.spawnSync({ cmd: ["git", "-C", repoDir, "rev-parse", "HEAD"] })
    .stdout.toString()
    .trim();
  const request = makeRequest({
    execution_id: "exec-7",
    worktree: { branchName: "cohort/epic/1-unit", worktreeSubdir: "epic/1-unit", baseRef: head },
  });
  const reference = await adapter.start_or_attach(request, "op-7" as ExecutorOperationId);
  if (reference.kind !== "kbbl_session") throw new Error("expected session");
  const row = harness.store.getSession(reference.session_id as KbblSessionId);
  expect(row?.worktree_branch).toBe("cohort/epic/1-unit");
  expect(reference.worktree_base_sha).toBe(row?.worktree_base_ref ?? "");
});

test("inherited worktrees chain through workspace_source, and the sha still reaches DBOS", async () => {
  makeHarness();
  const parent = await adapter.start_or_attach(
    makeRequest({ execution_id: "exec-8" }),
    "op-8" as ExecutorOperationId,
  );
  if (parent.kind !== "kbbl_session") throw new Error("expected session");

  const child = await adapter.start_or_attach(
    makeRequest({
      execution_id: "exec-9",
      workspace_source: { execution_id: "exec-8", external_reference: parent },
    }),
    "op-9" as ExecutorOperationId,
  );
  if (child.kind !== "kbbl_session") throw new Error("expected session");
  const childRow = harness.store.getSession(child.session_id as KbblSessionId);
  expect(childRow?.parent_sid).toBe(parent.session_id as KbblSessionId);
  expect(child.worktree_base_sha).toMatch(/^[0-9a-f]{40}$/);
});
