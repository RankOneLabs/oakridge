import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Database } from "bun:sqlite";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { builtinAgentProfiles } from "../acp/default-profiles";
import type { AcpSessionService } from "../acp/session-service";
import { acpError, err } from "../acp/types";
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
    listSessions: () => [],
    listSessionArchives: () => new Map(),
    transcriptLimits: { initial_item_window: 20, item_page_limit: 20, item_page_limit_max: 100 },
    readItemPage: (sid: string) => err(acpError("session_not_found", "service.readItemPage", `no session ${sid}`)),
    listProfiles: () => {
      const defaults = builtinAgentProfiles("/tmp/kbbl");
      return profiles.map((profile) => ({
        models: defaults.get(profile.id)?.models,
        default_model: defaults.get(profile.id)?.default_model,
        ...profile,
      }));
    },
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

const bundle = "console.log('kbbl');\n".repeat(200);

function writeStaticFixtures() {
  mkdirSync(join(tmpRoot, "assets"));
  writeFileSync(join(tmpRoot, "assets", "index-abc123.js"), bundle);
  writeFileSync(join(tmpRoot, "index.html"), "<!doctype html>");
}

describe("static PWA", () => {
  beforeEach(writeStaticFixtures);

  test("a hashed asset is cached for good and compressed", async () => {
    const res = await buildApp(KbblConfigSchema.parse({})).request("/assets/index-abc123.js", { headers: { "accept-encoding": "gzip" } });
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(Bun.gunzipSync(await res.arrayBuffer()).length).toBe(bundle.length);
  });

  test("the entry page is revalidated, so a new build's asset names reach the client", async () => {
    const res = await buildApp(KbblConfigSchema.parse({})).request("/");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });
});

describe("token-mode access", () => {
  const token = "control-test-token";
  const bearerHeaders = { authorization: `Bearer ${token}` };
  const itemsPath = "/sessions/00000000-0000-4000-8000-000000000001/items?epoch=test&before_seq=0";
  let app: Hono;

  beforeEach(() => {
    writeStaticFixtures();
    app = buildApp(KbblConfigSchema.parse({}), tmpRoot, undefined, { mode: "token", token });
  });

  test("GET /sessions/sid-1/items without credentials returns 401", async () => {
    expect((await app.request("/sessions/sid-1/items")).status).toBe(401);
  });

  for (const path of ["/sessions", "/config", "/directories", "/health", "/oakridge/config"]) {
    test.each(["GET", "HEAD"])("%s " + path + " without credentials returns 401", async (method) => {
      const url = path === "/directories" ? `${path}?path=${encodeURIComponent(tmpRoot)}` : path;
      expect((await app.request(url, { method })).status).toBe(401);
    });
  }

  test("GET /auth/status reports that anonymous users must sign in", async () => {
    const res = await app.request("/auth/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ is_required: true, is_authenticated: false });
  });

  test.each(["/", "/assets/index-abc123.js"])("GET %s serves the PWA without credentials", async (path) => {
    expect((await app.request(path)).status).toBe(200);
  });

  test.each(["/sessions", "/config", "/directories"])("GET %s accepts a valid Bearer token", async (path) => {
    const url = path === "/directories" ? `${path}?path=${encodeURIComponent(tmpRoot)}` : path;
    expect((await app.request(url, { headers: bearerHeaders })).status).toBe(200);
  });

  test("GET /sessions/:sid/items reaches the handler with a valid Bearer token", async () => {
    expect((await app.request(itemsPath, { headers: bearerHeaders })).status).toBe(404);
  });

  test("GET /config accepts a valid cookie with a same-origin Referer", async () => {
    const res = await app.request("/config", {
      headers: { cookie: `kbbl_ctrl=${token}`, referer: "http://localhost/" },
    });
    expect(res.status).toBe(200);
  });
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
      value: "fable",
      label: "fable 5.2",
    });
    expect(body.runtimes[0]?.efforts).toContainEqual({ value: "max", label: "max" });
    expect(body.runtimes[1]).toMatchObject({
      id: "codex",
      label: "Codex (ACP)",
    });
    expect(body.runtimes[1]?.models).toContainEqual({ value: "gpt-6.2-sol", label: "gpt-6.2 sol" });
    expect(body.runtimes[1]?.models).toContainEqual({ value: "gpt-6.2-astra", label: "gpt-6.2 astra" });
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

test("profile readiness requires credentials on GET and HEAD and shares authorized probes", async () => {
  let probes = 0;
  const app = createApp({ acp: makeStubAcp([]), defaultWorkdir: null, pwaDistDir: tmpRoot,
    getBunServer: () => null, config: KbblConfigSchema.parse({}), authPolicy: { mode: "token", token: "control-test-token" },
    readAgentProfiles: async () => { probes++; await Bun.sleep(10); return []; } });
  for (const method of ["GET", "HEAD"]) {
    expect((await app.request("/agent-profiles/readiness", { method })).status).toBe(401);
  }
  expect(probes).toBe(0);
  const responses = await Promise.all(Array.from({ length: 10 }, () => app.request("/agent-profiles/readiness", { headers: { authorization: "Bearer control-test-token" } })));
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(probes).toBe(1);
});
