import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import {
  checkObservationHealth,
  mountHealthRoutes,
  observationServerConfigFromEnv,
  type KbblHealth,
  type ObservationServerConfig,
} from "./observation-health";

const config: ObservationServerConfig = { url: "http://observation.test", namespace: "shadow", readToken: "read-secret", gradeToken: "grade-secret" };
const answering = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
const service = (graders: unknown, database = "available") => ({ service: "observation", status: "ok", database, graders });

const servers: Array<ReturnType<typeof Bun.serve>> = [];
afterEach(() => { for (const server of servers.splice(0)) void server.stop(true); });

describe("observationServerConfigFromEnv", () => {
  test("no URL means observation is not part of this deployment", () => {
    expect(observationServerConfigFromEnv({ OAKRIDGE_OBSERVATION_READ_TOKEN: "read" })).toBeNull();
  });
  test("reads the URL, namespace and both server-held capabilities", () => {
    expect(observationServerConfigFromEnv({ OAKRIDGE_OBSERVATION_URL: "http://o", OAKRIDGE_OBSERVATION_NAMESPACE: "shadow-a",
      OAKRIDGE_OBSERVATION_READ_TOKEN: "r", OAKRIDGE_OBSERVATION_GRADE_TOKEN: "g" }))
      .toEqual({ url: "http://o", namespace: "shadow-a", readToken: "r", gradeToken: "g" });
  });
});

describe("checkObservationHealth", () => {
  test("no configuration is distinct from a service that is down", async () => {
    expect(await checkObservationHealth({ config: null })).toEqual({ state: "not_configured" });
  });
  test("a closed port is down, however complete the configuration", async () => {
    const closed = Bun.serve({ port: 0, fetch: () => new Response() });
    const url = `http://127.0.0.1:${closed.port}`;
    await closed.stop(true);
    expect(await checkObservationHealth({ config: { ...config, url } })).toEqual({ state: "down", reason: "unreachable" });
  });
  test("a reachable service with nothing registered has no configured graders", async () => {
    expect(await checkObservationHealth({ config, fetcher: answering(service({ state: "none_configured" })) }))
      .toEqual({ state: "no_configured_graders" });
  });
  test("graders come from what the service reports as registered", async () => {
    const graders = { state: "configured", graders: [{ runner: "jev_direct", evaluator_definition_id: "evaluator-1" }] };
    expect(await checkObservationHealth({ config, fetcher: answering(service(graders)) }))
      .toEqual({ state: "configured", graders: [{ runner: "jev_direct", evaluatorDefinitionId: "evaluator-1" }] });
  });
  test("a service reporting no database is down, with that reason", async () => {
    expect(await checkObservationHealth({ config, fetcher: answering(service({ state: "none_configured" }, "unavailable"), 503) }))
      .toEqual({ state: "down", reason: "database_unavailable" });
  });
  test("any other failed response is an HTTP error", async () => {
    expect(await checkObservationHealth({ config, fetcher: answering({}, 500) })).toEqual({ state: "down", reason: "http_error" });
  });
  test("an open port speaking something else is not a healthy service", async () => {
    expect(await checkObservationHealth({ config, fetcher: answering({ status: "ok" }) })).toEqual({ state: "down", reason: "invalid_response" });
  });
  test("a server that accepts and never answers is bounded", async () => {
    const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    servers.push(hung);
    const started = Date.now();
    expect(await checkObservationHealth({ config: { ...config, url: `http://127.0.0.1:${hung.port}` }, timeoutMs: 50 }))
      .toEqual({ state: "down", reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });
  test("a body that stalls after its headers is bounded too", async () => {
    const stalled = Bun.serve({ port: 0, fetch: () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("{")); } })) });
    servers.push(stalled);
    expect(await checkObservationHealth({ config: { ...config, url: `http://127.0.0.1:${stalled.port}` }, timeoutMs: 50 }))
      .toEqual({ state: "down", reason: "timeout" });
  });
});

describe("GET /health", () => {
  const read = async (check: Parameters<typeof mountHealthRoutes>[1]): Promise<{ text: string; body: KbblHealth; status: number }> => {
    const app = new Hono();
    mountHealthRoutes(app, check);
    const response = await app.request("/health");
    const text = await response.text();
    return { text, body: JSON.parse(text) as KbblHealth, status: response.status };
  };
  test("kbbl stays healthy and reports the observation component separately", async () => {
    const result = await read({ config, fetcher: (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch });
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ status: "ok", observation: { state: "down", reason: "unreachable" }, capabilities: { read: true, grade: true } });
  });
  test("capabilities report presence and never a value", async () => {
    const result = await read({ config: { ...config, gradeToken: null }, fetcher: answering(service({ state: "none_configured" })) });
    expect(result.body.capabilities).toEqual({ read: true, grade: false });
    expect(result.text).not.toContain("read-secret");
  });
});
