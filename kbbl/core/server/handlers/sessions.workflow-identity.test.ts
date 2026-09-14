/**
 * PUT /sessions/resumable/:key's `workflow` member (migration 029): the
 * contract step 2's kbbl adapter sends against, exercised end to end
 * through the real Hono handler, the real AcpSessionService and store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountSessionsRoutes, parseWorkflowIdentity } from "./sessions";
import { makeAcpTestService, type AcpTestHarness } from "../../acp/test-harness";
import type { SessionManager } from "../../session/session-manager";
import type { PwaSessionSnapshot } from "../../acp/pwa-wire";

let repoDir: string;
let harness: AcpTestHarness;

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const proc = Bun.spawn({ cmd: ["git", "-C", cwd, ...args], stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
};

const stubManager = {
  listSnapshots: () => [],
  listArchivedSnapshots: async () => [],
  listByArtifact: () => [],
  remove: async () => false,
} as unknown as SessionManager;

function makeApp(): Hono {
  const app = new Hono();
  mountSessionsRoutes(app, { acp: harness.service, manager: stubManager, defaultWorkdir: repoDir });
  return app;
}

async function ensureResumable(app: Hono, key: string, body: Record<string, unknown>): Promise<Response> {
  return app.request(`/sessions/resumable/${key}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ initial_prompt: "build it", workdir: repoDir, runtime: "claude-code", ...body }),
  });
}

async function getSessions(app: Hono): Promise<PwaSessionSnapshot[]> {
  const res = await app.request("/sessions");
  const body = (await res.json()) as { sessions: PwaSessionSnapshot[] };
  return body.sessions;
}

const WORKFLOW = {
  workflow_run_id: "run-1",
  stage_instance_id: "stage-1",
  unit_id: "cohort-a",
  operator_role: "build",
  cohort_title: "Targets spec contract",
  repository_key: "pipefitter",
};

beforeEach(async () => {
  repoDir = mkdtempSync(join(tmpdir(), "kbbl-workflow-identity-test-"));
  await git(repoDir, "init", "-q", "-b", "main");
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "test");
  await git(repoDir, "config", "commit.gpgsign", "false");
  await git(repoDir, "config", "tag.gpgsign", "false");
  await git(repoDir, "commit", "--allow-empty", "-m", "init");
  harness = makeAcpTestService({ stateDir: mkdtempSync(join(tmpdir(), "kbbl-workflow-identity-state-")) });
});

afterEach(async () => {
  await harness.service.shutdown();
  rmSync(repoDir, { recursive: true, force: true });
});

describe("PUT /sessions/resumable/:key workflow member", () => {
  test("a supplied workflow round-trips through GET /sessions in camelCase", async () => {
    const app = makeApp();
    const res = await ensureResumable(app, "build-1", { workflow: WORKFLOW });
    expect(res.status).toBe(201);

    const sessions = await getSessions(app);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.workflow).toEqual({
      runId: "run-1",
      stageInstanceId: "stage-1",
      unitId: "cohort-a",
      operatorRole: "build",
      cohortTitle: "Targets spec contract",
      repositoryKey: "pipefitter",
    });
  });

  test("no workflow member succeeds with a null workflow", async () => {
    const app = makeApp();
    const res = await ensureResumable(app, "build-2", {});
    expect(res.status).toBe(201);
    const sessions = await getSessions(app);
    expect(sessions[0]?.workflow).toBeNull();
  });

  test("re-ensuring an already-claimed key with the identical spec and no workflow leaves the stored identity untouched", async () => {
    const app = makeApp();
    await ensureResumable(app, "build-3", { workflow: WORKFLOW });
    const res = await ensureResumable(app, "build-3", {});
    expect(res.status).toBe(200);
    const sessions = await getSessions(app);
    expect(sessions[0]?.workflow?.cohortTitle).toBe("Targets spec contract");
  });

  test("re-ensuring a key claimed without an identity backfills the supplied one", async () => {
    const app = makeApp();
    await ensureResumable(app, "build-4", {});
    const res = await ensureResumable(app, "build-4", { workflow: WORKFLOW });
    expect(res.status).toBe(200);
    const sessions = await getSessions(app);
    expect(sessions[0]?.workflow?.unitId).toBe("cohort-a");
  });

  test("re-ensuring with a differing identity over a stored non-null one attaches unchanged, no error", async () => {
    const app = makeApp();
    await ensureResumable(app, "build-5", { workflow: WORKFLOW });
    const res = await ensureResumable(app, "build-5", {
      workflow: { ...WORKFLOW, cohort_title: "A different title" },
    });
    expect(res.status).toBe(200);
    const sessions = await getSessions(app);
    expect(sessions[0]?.workflow?.cohortTitle).toBe("Targets spec contract");
  });

  test("a malformed workflow (missing unit_id) is a 400", async () => {
    const app = makeApp();
    const { unit_id: _unitId, ...withoutUnitId } = WORKFLOW;
    const res = await ensureResumable(app, "build-6", { workflow: withoutUnitId });
    expect(res.status).toBe(400);
  });

  test("a malformed workflow (non-string member) is a 400", async () => {
    const app = makeApp();
    const res = await ensureResumable(app, "build-7", { workflow: { ...WORKFLOW, operator_role: 5 } });
    expect(res.status).toBe(400);
  });
});

describe("parseWorkflowIdentity", () => {
  test("absent workflow parses to a null value", () => {
    expect(parseWorkflowIdentity(undefined)).toEqual({ value: null });
  });

  test("empty optional members normalize to null", () => {
    const result = parseWorkflowIdentity({
      workflow_run_id: "run-1", stage_instance_id: "stage-1", unit_id: "unit-1",
      operator_role: "", cohort_title: "", repository_key: "",
    });
    expect(result).toEqual({
      value: {
        workflow_run_id: "run-1", stage_instance_id: "stage-1", unit_id: "unit-1",
        operator_role: null, cohort_title: null, repository_key: null,
      },
    });
  });

  test("a non-object workflow is rejected", () => {
    expect(parseWorkflowIdentity("nope")).toEqual({ error: "workflow must be an object" });
  });
});
