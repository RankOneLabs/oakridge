import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import { langfuseConfigFromEnv } from "../src/langfuse/config";
import type { Database } from "../src/storage/database";

test("missing configuration disables Langfuse while operator routes remain available", async () => {
  const configuration = langfuseConfigFromEnv({});
  expect(configuration).toEqual({ ok: true, value: { status: "disabled" } });
  if (!configuration.ok) return;
  const app = createApp({ db: {} as Database, langfuse: configuration.value, credentials: {
    ingest: [], read: [{ producer: "oakridge", namespace: "pilot", token: "read-token" }],
    grade: [{ producer: "oakridge", namespace: "pilot", token: "grade-token" }], export_raw: [] } });
  for (const [method, path, token] of [
    ["GET", "/v1/langfuse/status", "read-token"],
    ["POST", "/v1/langfuse/projections", "grade-token"],
    ["POST", "/v1/langfuse/reconcile", "grade-token"],
  ] as const) {
    const response = await app.request(path, { method, headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "disabled" });
  }
  const forbidden = await app.request("/v1/langfuse/status", { headers: { Authorization: "Bearer grade-token" } });
  expect(forbidden.status).toBe(403);
});

test("partial configuration reports only field names, never supplied secret material", () => {
  const parsed = langfuseConfigFromEnv({ OBSERVATION_LANGFUSE_SECRET_KEY: "sensitive-value" });
  expect(parsed.ok).toBe(false);
  expect(JSON.stringify(parsed)).not.toContain("sensitive-value");
});
