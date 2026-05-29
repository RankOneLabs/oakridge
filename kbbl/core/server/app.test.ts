import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import { KbblConfigSchema, type KbblConfig } from "../config";
import type { AppRuntime } from "../runtime";
import type { SessionManager } from "../session/session-manager";
import type { createDispatcher } from "../orchestrator/backends/dispatcher";
import { openTestDb } from "../db/test-db";
import { createApp } from "./app";

let tmpRoot: string;
let configPath: string;
let db: Database;

function buildApp(config: KbblConfig, defaultWorkdir: string | null = "/tmp/test-workdir"): Hono {
  const runtime: AppRuntime = {
    id: "test",
    mountRoutes: () => {},
    buildSpawnCmd: async () => { throw new Error("not used in config tests"); },
  };
  const dispatcher: ReturnType<typeof createDispatcher> = {
    dispatch: async () => { throw new Error("not used in config tests"); },
  };
  return createApp({
    manager: {} as unknown as SessionManager,
    runtime,
    defaultWorkdir,
    sessionsDir: tmpRoot,
    handoffsDir: tmpRoot,
    pwaDistDir: tmpRoot,
    getBunServer: () => null,
    config,
    configPath,
    db,
    dispatcher,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-app-test-"));
  configPath = join(tmpRoot, "config.json");
  db = openTestDb();
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /config", () => {
  test("returns defaultWorkdir and softThresholdTokens", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultWorkdir: string | null; softThresholdTokens: number };
    expect(body.defaultWorkdir).toBe("/tmp/test-workdir");
    expect(body.softThresholdTokens).toBe(config.compact.soft_threshold_tokens);
  });

  test("allows a null defaultWorkdir", async () => {
    const app = buildApp(KbblConfigSchema.parse({}), null);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultWorkdir: string | null };
    expect(body.defaultWorkdir).toBeNull();
  });

  test("returns stageDefaults with STAGE_ROUTING values when no config.runtime.stages override", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stageDefaults: {
        planner: { runtime: string; model: string };
        build: { runtime: string; model: string };
      };
    };
    expect(body.stageDefaults.planner.runtime).toBe("claude-code");
    expect(body.stageDefaults.planner.model).toBe("claude-opus-4-8");
    expect(body.stageDefaults.build.runtime).toBe("claude-code");
    expect(body.stageDefaults.build.model).toBe("claude-sonnet-4-6");
  });

  test("stageDefaults reflects config.runtime.stages override", async () => {
    const config = KbblConfigSchema.parse({
      runtime: { stages: { plan_writer: { runtime: "codex", model: "codex-custom" } } },
    });
    const app = buildApp(config);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      stageDefaults: { planner: { runtime: string; model: string } };
    };
    expect(body.stageDefaults.planner.runtime).toBe("codex");
    expect(body.stageDefaults.planner.model).toBe("codex-custom");
  });
});

describe("PATCH /config", () => {
  test("rejects invalid JSON body", async () => {
    const app = buildApp(KbblConfigSchema.parse({}));
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/invalid json/);
  });

  test("rejects empty body with no settable fields", async () => {
    const app = buildApp(KbblConfigSchema.parse({}));
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/no settable fields/);
  });

  test("rejects non-integer softThresholdTokens", async () => {
    const app = buildApp(KbblConfigSchema.parse({}));
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softThresholdTokens: 1.5 }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/positive integer/);
  });

  test("rejects softThresholdTokens >= hard threshold", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);
    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softThresholdTokens: config.compact.hard_threshold_tokens }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/< hardThresholdTokens/);
  });

  test("persists softThresholdTokens and returns the updated value", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const patchRes = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ softThresholdTokens: 12345 }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { softThresholdTokens: number };
    expect(patchBody.softThresholdTokens).toBe(12345);

    // In-memory config is mutated so the next GET reflects the new value.
    const getRes = await app.request("/config");
    const getBody = (await getRes.json()) as { softThresholdTokens: number };
    expect(getBody.softThresholdTokens).toBe(12345);

    // And the change is persisted to disk so it survives a server restart.
    const persisted = JSON.parse(readFileSync(configPath, "utf8")) as {
      compact: { soft_threshold_tokens: number };
    };
    expect(persisted.compact.soft_threshold_tokens).toBe(12345);
  });
});

describe("GET /directories", () => {
  test("lists child directories for the picker", async () => {
    mkdirSync(join(tmpRoot, "repo-a"));
    mkdirSync(join(tmpRoot, "repo-b"));
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request(`/directories?path=${encodeURIComponent(tmpRoot)}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      entries: Array<{ name: string; path: string }>;
    };
    expect(body.path).toBe(tmpRoot);
    expect(body.entries.map((entry) => entry.name)).toEqual(["repo-a", "repo-b"]);
  });

  test("omits hidden child directories from the picker", async () => {
    mkdirSync(join(tmpRoot, ".hidden-repo"));
    mkdirSync(join(tmpRoot, "visible-repo"));
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request(`/directories?path=${encodeURIComponent(tmpRoot)}`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: Array<{ name: string; path: string }>;
    };
    expect(body.entries.map((entry) => entry.name)).toEqual(["visible-repo"]);
  });

  test("rejects relative directory paths", async () => {
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request("/directories?path=./relative");

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("path must be absolute");
  });

  test("rejects non-directory paths", async () => {
    const filePath = join(tmpRoot, "not-a-dir.txt");
    writeFileSync(filePath, "not a directory", "utf8");
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);

    const res = await app.request(`/directories?path=${encodeURIComponent(filePath)}`);

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe("path is not a directory");
  });

  test("rejects paths outside allowed roots", async () => {
    const outsideRoot = mkdtempSync(join(tmpdir(), "kbbl-app-outside-"));
    const app = buildApp(KbblConfigSchema.parse({}), tmpRoot);
    try {
      const res = await app.request(`/directories?path=${encodeURIComponent(outsideRoot)}`);

      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        "path is outside allowed directory roots",
      );
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });

  test("allows paths under a root directory default workdir", async () => {
    const app = buildApp(KbblConfigSchema.parse({}), "/");

    const res = await app.request(`/directories?path=${encodeURIComponent(tmpRoot)}`);

    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe(tmpRoot);
  });
});
