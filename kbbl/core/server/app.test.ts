import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import { KbblConfigSchema, type KbblConfig } from "../config";
import type { AcpSessionService } from "../acp/session-service";
import { openTestDb } from "../db/test-db";
import { createApp } from "./app";
import type { AuthPolicy } from "./auth";

let tmpRoot: string;
let db: Database;

function makeStubAcp(
  profiles: Array<{ id: string; label: string; enabled: boolean }>,
  defaultAgent = "claude-code",
): AcpSessionService {
  return {
    listProfiles: () => profiles,
    get defaultAgent() {
      return defaultAgent;
    },
  } as unknown as AcpSessionService;
}

function buildApp(
  config: KbblConfig,
  defaultWorkdir: string | null = "/tmp/test-workdir",
  acp: AcpSessionService = makeStubAcp([
    { id: "claude-code", label: "Claude Code (ACP)", enabled: true },
    { id: "codex", label: "Codex (ACP)", enabled: true },
  ]),
  authPolicy?: AuthPolicy,
): Hono {
  return createApp({
    acp,
    defaultWorkdir,
    pwaDistDir: tmpRoot,
    getBunServer: () => null,
    config,
    authPolicy,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-app-test-"));

  db = openTestDb();
});

afterEach(() => {
  db.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /config", () => {
  test("returns defaultWorkdir", async () => {
    const app = buildApp(KbblConfigSchema.parse({}));

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultWorkdir: string | null };
    expect(body.defaultWorkdir).toBe("/tmp/test-workdir");
  });

  test("returns launch choices for built-in ACP profiles", async () => {
    const acp = makeStubAcp(
      [
        { id: "claude-code", label: "Claude Code (ACP)", enabled: true },
        { id: "codex", label: "Codex (ACP)", enabled: true },
        { id: "disabled-agent", label: "Disabled", enabled: false },
      ],
      "codex",
    );
    const app = buildApp(KbblConfigSchema.parse({}), "/tmp/test-workdir", acp);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      defaultRuntimeId: string;
      runtimes: Array<{
        id: string;
        label: string;
        supportsCompaction: boolean;
        models: unknown[];
        efforts: unknown[];
      }>;
    };
    expect(body.defaultRuntimeId).toBe("codex");
    expect(body.runtimes).toHaveLength(2);
    expect(body.runtimes[0]).toMatchObject({
      id: "claude-code",
      label: "Claude Code (ACP)",
    });
    expect(body.runtimes[0]?.models).toContainEqual({
      value: "claude-fable-5-1",
      label: "fable 5.1",
    });
    expect(body.runtimes[0]?.efforts).toContainEqual({ value: "max", label: "max" });
    expect(body.runtimes[1]).toMatchObject({
      id: "codex",
      label: "Codex (ACP)",
    });
    expect(body.runtimes[1]?.models).toContainEqual({
      value: "gpt-6-astra",
      label: "gpt-6 astra",
    });
    expect(body.runtimes[1]?.efforts).toContainEqual({ value: "ultra", label: "ultra" });
  });

  test("allows a null defaultWorkdir", async () => {
    const app = buildApp(KbblConfigSchema.parse({}), null);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaultWorkdir: string | null };
    expect(body.defaultWorkdir).toBeNull();
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
