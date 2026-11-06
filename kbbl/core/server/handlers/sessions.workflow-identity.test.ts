/**
 * PUT /sessions/resumable/:key's `workflow` member (migration 029): the
 * contract step 2's kbbl adapter sends against, exercised end to end
 * through the real Hono handler, the real AcpSessionService and store.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { mountSessionsRoutes, parseWorkflowIdentity } from "./sessions";
import { makeAcpTestService, type AcpTestHarness } from "../../acp/test-harness";
import type { PwaSessionSnapshot } from "../../acp/pwa-wire";
import type { KbblSessionId } from "../../acp/types";

let tmpRoot: string;
let repoDir: string;
let harness: AcpTestHarness;

const git = async (cwd: string, ...args: string[]): Promise<void> => {
  const proc = Bun.spawn({ cmd: ["git", "-C", cwd, ...args], stdout: "ignore", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
};


function makeApp(): Hono {
  const app = new Hono();
  mountSessionsRoutes(app, { acp: harness.service, defaultWorkdir: repoDir });
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

const WORKFLOW = { run_id: "run-1", unit_id: "run-1/cohort/a", worker: "builder" };

beforeEach(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-workflow-identity-test-"));
  repoDir = join(tmpRoot, "repo");
  mkdirSync(repoDir, { recursive: true });
  mkdirSync(join(tmpRoot, "state"), { recursive: true });
  await git(repoDir, "init", "-q", "-b", "main");
  await git(repoDir, "config", "user.email", "test@example.com");
  await git(repoDir, "config", "user.name", "test");
  await git(repoDir, "config", "commit.gpgsign", "false");
  await git(repoDir, "config", "tag.gpgsign", "false");
  await git(repoDir, "commit", "--allow-empty", "-m", "init");
  harness = makeAcpTestService({ stateDir: join(tmpRoot, "state") });
});

afterEach(async () => {
  await harness.service.shutdown();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("PUT /sessions/resumable/:key workflow member", () => {
  test("every agent class receives the configured gated-review URL unchanged", async () => {
    const previous = process.env.OAKRIDGE_GATED_REVIEW_URL;
    const url = "http://127.0.0.1:3555/mcp/";
    process.env.OAKRIDGE_GATED_REVIEW_URL = url;
    try {
      const app = makeApp();
      for (const worker of ["author", "spec_editor", "planner", "writer", "builder", "assessor", "integrator", "renamed-worker"]) {
        const res = await ensureResumable(app, `agent-${worker}`, { workflow: { ...WORKFLOW, worker } });
        expect(res.status).toBe(201);
        const sessions = await getSessions(app);
        const sid = sessions.find((session) => session.workflow?.worker === worker)?.sid as KbblSessionId;
        await harness.service.observeInitialTurn(sid, 8000);
        const agentSessionId = harness.store.getSession(sid)?.acp_session_id;
        if (!agentSessionId) throw new Error("agent session missing");
        const servers = JSON.parse(readFileSync(join(tmpRoot, "state", `${agentSessionId}.mcp-servers.json`), "utf8"));
        expect({ worker, servers }).toEqual({ worker, servers: [{ type: "http", name: "gated-review", url, headers: [] }] });
      }
    } finally {
      if (previous === undefined) delete process.env.OAKRIDGE_GATED_REVIEW_URL;
      else process.env.OAKRIDGE_GATED_REVIEW_URL = previous;
    }
  }, 60000);

  test("a supplied workflow round-trips through GET /sessions in camelCase", async () => {
    const app = makeApp();
    const res = await ensureResumable(app, "build-1", { workflow: WORKFLOW });
    expect(res.status).toBe(201);

    const sessions = await getSessions(app);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.workflow).toEqual({ runId: "run-1", unitId: "run-1/cohort/a", worker: "builder" });
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
    expect(sessions[0]?.workflow?.worker).toBe("builder");
  });

  test("re-ensuring a key claimed without an identity backfills the supplied one", async () => {
    const app = makeApp();
    await ensureResumable(app, "build-4", {});
    const res = await ensureResumable(app, "build-4", { workflow: WORKFLOW });
    expect(res.status).toBe(200);
    const sessions = await getSessions(app);
    expect(sessions[0]?.workflow?.unitId).toBe("run-1/cohort/a");
  });

  test("re-ensuring with a differing identity over a stored non-null one attaches unchanged, no error", async () => {
    const app = makeApp();
    await ensureResumable(app, "build-5", { workflow: WORKFLOW });
    const res = await ensureResumable(app, "build-5", {
      workflow: { ...WORKFLOW, worker: "assessor" },
    });
    expect(res.status).toBe(200);
    const sessions = await getSessions(app);
    expect(sessions[0]?.workflow?.worker).toBe("builder");
  });

  test("a malformed workflow (missing unit_id) is a 400", async () => {
    const app = makeApp();
    const { unit_id: _unitId, ...withoutUnitId } = WORKFLOW;
    const res = await ensureResumable(app, "build-6", { workflow: withoutUnitId });
    expect(res.status).toBe(400);
  });

  test("a malformed workflow (non-string member) is a 400", async () => {
    const app = makeApp();
    const res = await ensureResumable(app, "build-7", { workflow: { ...WORKFLOW, worker: 5 } });
    expect(res.status).toBe(400);
  });
});

describe("parseWorkflowIdentity", () => {
  test("absent workflow parses to a null value", () => {
    expect(parseWorkflowIdentity(undefined)).toEqual({ value: null });
  });

  test("the run, unit and worker are trimmed and required", () => {
    expect([parseWorkflowIdentity({ run_id: " run-1 ", unit_id: "unit-1", worker: "builder" }),
      parseWorkflowIdentity({ run_id: "run-1", unit_id: "unit-1", worker: "" })]).toEqual([
      { value: { run_id: "run-1", unit_id: "unit-1", worker: "builder" } }, { error: "workflow.worker must be a non-empty string" }]);
  });

  test("a non-object workflow is rejected", () => {
    expect(parseWorkflowIdentity("nope")).toEqual({ error: "workflow must be an object" });
  });

  test("a removed grant field on the wire is not part of the identity", () => {
    expect(parseWorkflowIdentity({ ...WORKFLOW, gated_review: { kind: "unscoped" } })).toEqual({ value: WORKFLOW });
  });
});
