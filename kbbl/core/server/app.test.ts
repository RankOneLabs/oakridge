import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";

import { KbblConfigSchema, type KbblConfig } from "../config";
import type { AppRuntime } from "../runtime";
import type { SafirClient } from "../safir/client";
import type { SessionManager } from "../session/session-manager";
import type { ProposalStore } from "../proposals/store";
import { createApp } from "./app";

let tmpRoot: string;
let configPath: string;

function buildApp(config: KbblConfig): Hono {
  const runtime: AppRuntime = {
    id: "test",
    mountRoutes: () => {},
    buildSpawnCmd: async () => { throw new Error("not used in config tests"); },
  };
  return createApp({
    manager: {} as unknown as SessionManager,
    runtime,
    defaultWorkdir: "/tmp/test-workdir",
    sessionsDir: tmpRoot,
    handoffsDir: tmpRoot,
    pwaDistDir: tmpRoot,
    safirClient: {} as unknown as SafirClient,
    proposalStore: {} as unknown as ProposalStore,
    getBunServer: () => null,
    config,
    configPath,
  });
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-app-test-"));
  configPath = join(tmpRoot, "config.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("GET /config", () => {
  test("returns default safirWebUrl when config.safir.web_url is not in config.json", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { safirWebUrl: string };
    expect(body.safirWebUrl).toBe("http://localhost:3000");
  });

  test("returns operator-set safirWebUrl when set in config", async () => {
    const config = KbblConfigSchema.parse({
      safir: { web_url: "https://safir.example/" },
    });
    const app = buildApp(config);

    const res = await app.request("/config");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { safirWebUrl: string };
    expect(body.safirWebUrl).toBe("https://safir.example/");
  });
});

describe("PATCH /config safirWebUrl", () => {
  test("persists safirWebUrl and surfaces it on subsequent GET", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const patchRes = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ safirWebUrl: "https://example.test" }),
    });

    expect(patchRes.status).toBe(200);
    const patchBody = (await patchRes.json()) as { safirWebUrl: string };
    expect(patchBody.safirWebUrl).toBe("https://example.test");

    const getRes = await app.request("/config");
    const getBody = (await getRes.json()) as { safirWebUrl: string };
    expect(getBody.safirWebUrl).toBe("https://example.test");
  });

  test("rejects safirWebUrl: 'not-a-url' with 400", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ safirWebUrl: "not-a-url" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/safirWebUrl/);
  });

  test("updates both softThresholdTokens and safirWebUrl atomically", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const patchRes = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        softThresholdTokens: 60000,
        safirWebUrl: "https://safir.example",
      }),
    });

    expect(patchRes.status).toBe(200);

    const getRes = await app.request("/config");
    const getBody = (await getRes.json()) as {
      softThresholdTokens: number;
      safirWebUrl: string;
    };
    expect(getBody.softThresholdTokens).toBe(60000);
    expect(getBody.safirWebUrl).toBe("https://safir.example");
  });

  test("empty body returns 400 with no settable fields message", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/no settable fields/);
  });

  test("non-string safirWebUrl returns 400", async () => {
    const config = KbblConfigSchema.parse({});
    const app = buildApp(config);

    const res = await app.request("/config", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ safirWebUrl: 123 }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/safirWebUrl/);
  });
});
