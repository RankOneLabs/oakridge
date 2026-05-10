import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { createSafirClient, type FetchFn } from "../safir/client";
import { createSafirQueue } from "../safir/queue";
import type { PermissionProfile } from "../safir/types";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;
let handoffsDir: string;

// A spawn that exits immediately so tests don't leave hanging processes
async function quickExitSpawn(_session: Session): Promise<SpawnCmd> {
  return {
    cmd: ["bun", "-e", ""],
    cwd: tmpRoot,
    env: { ...process.env } as Record<string, string>,
  };
}

function buildConfig(): KbblConfig {
  return KbblConfigSchema.parse({
    sessions: { worktree_per_session: false },
  });
}

function makeProfile(
  id: number,
  name: string,
  isSeed = false,
  compactOverrides?: PermissionProfile["rules"]["compact_overrides"],
): PermissionProfile {
  return {
    id,
    name,
    description: null,
    is_seed: isSeed,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    rules: {
      auto_approve: [],
      always_prompt: [],
      deny: [],
      ...(compactOverrides ? { compact_overrides: compactOverrides } : {}),
    },
  };
}

const SCOPED_WRITE = makeProfile(10, "scoped-write", true);
const EXPLICIT_PROFILE = makeProfile(20, "explicit-profile");
const TASK_DEFAULT_PROFILE = makeProfile(30, "task-default");

function makeStub(opts: {
  profiles?: PermissionProfile[];
  taskDefaultProfileId?: number | null;
  taskId?: number;
}): { fetch: FetchFn } {
  const profiles = opts.profiles ?? [SCOPED_WRITE];
  const fetchFn: FetchFn = async (input) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");

    if (path === "/permission-profiles") {
      return Response.json(profiles, { status: 200 });
    }
    const profMatch = /^\/permission-profiles\/(\d+)$/.exec(path);
    if (profMatch) {
      const id = Number(profMatch[1]);
      const found = profiles.find((p) => p.id === id);
      if (!found) return Response.json({ error: "not found" }, { status: 404 });
      return Response.json(found, { status: 200 });
    }
    const taskMatch = /^\/tasks\/(\d+)$/.exec(path);
    if (taskMatch) {
      const tid = Number(taskMatch[1]);
      return Response.json({
        id: tid,
        project_id: "proj-1",
        parent_id: null,
        title: "test task",
        status: "open",
        default_permission_profile_id: opts.taskDefaultProfileId ?? null,
      }, { status: 200 });
    }
    if (/^\/tasks\/\d+\/runs$/.test(path)) {
      return Response.json({ id: "run-stub", task_id: 1, executor: "claude_code", status: "running", permission_profile_id: null, pipeline_id: null, pipeline_version: null, brief: null, result_summary: null, started_at: "2026-01-01T00:00:00Z", finished_at: null, created_by: "kbbl", created_by_session: null }, { status: 201 });
    }
    if (/^\/runs\/[^/]+\/phases$/.test(path)) {
      return Response.json({ id: "phase-stub", run_id: "run-stub", phase_index: 0, oakridge_session_id: null, external_execution_id: null, parent_phase_id: null, started_at: "2026-01-01T00:00:00Z", ended_at: null, end_reason: null, is_terminal: false }, { status: 201 });
    }
    return Response.json({ error: `stub: unhandled ${path}` }, { status: 404 });
  };
  return { fetch: fetchFn };
}

function makeManager(fetchFn: FetchFn): SessionManager {
  const safirClient = createSafirClient({ baseUrl: "http://safir.test", fetch: fetchFn });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return new SessionManager({
    sessionsDir,
    handoffsDir,
    worktreesDir,
    buildSpawnCmd: quickExitSpawn,
    config: buildConfig(),
    safirClient,
    safirQueue,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-profile-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  handoffsDir = join(tmpRoot, "handoffs");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(handoffsDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("permission profile resolution order", () => {
  test("no taskId and no explicit profile_id → null profile", async () => {
    const { fetch } = makeStub({});
    const mgr = makeManager(fetch);
    const session = await mgr.create({ workdir: tmpRoot });
    expect(session.permissionProfile).toBeNull();
  });

  test("explicit permission_profile_id wins over task default", async () => {
    const allProfiles = [SCOPED_WRITE, EXPLICIT_PROFILE, TASK_DEFAULT_PROFILE];
    const { fetch } = makeStub({
      profiles: allProfiles,
      taskId: 5,
      taskDefaultProfileId: TASK_DEFAULT_PROFILE.id,
    });
    const mgr = makeManager(fetch);
    const session = await mgr.create({
      workdir: tmpRoot,
      taskId: 5,
      permission_profile_id: EXPLICIT_PROFILE.id,
    });
    expect(session.permissionProfile?.id).toBe(EXPLICIT_PROFILE.id);
    expect(session.permissionProfile?.name).toBe("explicit-profile");
  });

  test("task default_permission_profile_id is used when no explicit profile", async () => {
    const allProfiles = [SCOPED_WRITE, TASK_DEFAULT_PROFILE];
    const { fetch } = makeStub({
      profiles: allProfiles,
      taskId: 5,
      taskDefaultProfileId: TASK_DEFAULT_PROFILE.id,
    });
    const mgr = makeManager(fetch);
    const session = await mgr.create({ workdir: tmpRoot, taskId: 5 });
    expect(session.permissionProfile?.id).toBe(TASK_DEFAULT_PROFILE.id);
    expect(session.permissionProfile?.name).toBe("task-default");
  });

  test("task with no default falls back to scoped-write", async () => {
    const { fetch } = makeStub({ profiles: [SCOPED_WRITE], taskDefaultProfileId: null });
    const mgr = makeManager(fetch);
    const session = await mgr.create({ workdir: tmpRoot, taskId: 7 });
    expect(session.permissionProfile?.id).toBe(SCOPED_WRITE.id);
    expect(session.permissionProfile?.name).toBe("scoped-write");
  });

  test("missing scoped-write seed degrades gracefully to null", async () => {
    // profiles list is empty — scoped-write is not present
    const { fetch } = makeStub({ profiles: [], taskDefaultProfileId: null });
    const mgr = makeManager(fetch);
    const session = await mgr.create({ workdir: tmpRoot, taskId: 7 });
    expect(session.permissionProfile).toBeNull();
  });

  test("scoped-write fallback is cached after first lookup", async () => {
    let listCallCount = 0;
    const baseFetch = makeStub({ profiles: [SCOPED_WRITE], taskDefaultProfileId: null }).fetch;
    const countingFetch: FetchFn = async (input, init) => {
      const url = typeof input === "string" ? input : (input as Request).url;
      const path = url.replace(/^https?:\/\/[^/]+/, "");
      if (path === "/permission-profiles") listCallCount++;
      return baseFetch(input, init);
    };
    const mgr = makeManager(countingFetch);

    await mgr.create({ workdir: tmpRoot, taskId: 1 });
    await mgr.create({ workdir: tmpRoot, taskId: 2 });
    // list called once for first lookup, result cached for second
    expect(listCallCount).toBe(1);
  });
});

describe("setPermissionProfile", () => {
  test("live-updates the session profile for gate decisions", async () => {
    const { fetch } = makeStub({ profiles: [SCOPED_WRITE], taskDefaultProfileId: null });
    const mgr = makeManager(fetch);
    const session = await mgr.create({ workdir: tmpRoot, taskId: 1 });

    const newProfile = makeProfile(99, "updated-inline");
    session.setPermissionProfile(newProfile);
    expect(session.permissionProfile?.id).toBe(99);
    expect(session.permissionProfile?.name).toBe("updated-inline");
  });
});
