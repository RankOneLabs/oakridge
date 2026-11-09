import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";

import type { ObservationServerConfig } from "./observation-health";
import { mountObservationProxyRoutes, type ObservationProxyDeps } from "./observation-proxy";

const observation: ObservationServerConfig = { url: "http://observation.test/", namespace: "shadow", readToken: "read-secret", gradeToken: "grade-secret" };
const ORIGIN = "http://kbbl.test";
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

interface Forwarded { url: string; method: string; authorization: string | null; headers: Record<string, string>; body: unknown }
function upstream(answer: (call: Forwarded) => Response = () => Response.json({ ok: true })): Forwarded[] {
  const calls: Forwarded[] = [];
  globalThis.fetch = (async (input, init) => {
    const headers = new Headers(init?.headers);
    const names: Record<string, string> = {};
    headers.forEach((value, name) => { names[name] = value; });
    const call: Forwarded = { url: String(input), method: init?.method ?? "GET", authorization: headers.get("authorization"),
      headers: names, body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return answer(call);
  }) as typeof fetch;
  return calls;
}
function mounted(overrides: Partial<ObservationProxyDeps> = {}): Hono {
  const app = new Hono();
  mountObservationProxyRoutes(app, { observation, browserControlToken: "browser-secret", allowedOrigins: [ORIGIN], ...overrides });
  return app;
}
const asOperator = { authorization: "Bearer browser-secret" };
const submission = { question_id: "assessment_finding.evidence_support", question_version: "1", submission_id: "s1", answer: "supports" };
const ITEM = encodeURIComponent("canonical-json/v1:abc");
const post = (app: Hono, body: unknown, headers: Record<string, string> = { ...asOperator, "content-type": "application/json" }) =>
  app.request(`/oakridge/observation/items/${ITEM}/answers`, { method: "POST", headers, body: JSON.stringify(body) });

describe("operator authentication comes first", () => {
  test("no credential forwards nothing, for a read or a write", async () => {
    const calls = upstream();
    const app = mounted();
    expect((await app.request("/oakridge/observation/runs/run-1/tasks")).status).toBe(401);
    expect((await post(app, submission, { "content-type": "application/json" })).status).toBe(401);
    expect(calls).toEqual([]);
  });
  test("a wrong credential forwards nothing, and the observation token is not an operator credential", async () => {
    const calls = upstream();
    const app = mounted();
    for (const token of ["wrong", "read-secret", "grade-secret"])
      expect((await app.request("/oakridge/observation/runs/run-1/tasks", { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
    expect(calls).toEqual([]);
  });
  test("the browser cookie passes a read and a same-origin write, and a foreign origin writes nothing", async () => {
    const calls = upstream();
    const app = mounted();
    const cookie = { cookie: "kbbl_ctrl=browser-secret" };
    expect((await app.request("/oakridge/observation/runs/run-1/tasks", { headers: cookie })).status).toBe(200);
    expect((await post(app, submission, { ...cookie, "content-type": "application/json", origin: ORIGIN })).status).toBe(200);
    expect(calls).toHaveLength(2);
    expect((await post(app, submission, { ...cookie, "content-type": "application/json", origin: "http://evil.test" })).status).toBe(403);
    expect((await post(app, submission, { ...cookie, "content-type": "application/json" })).status).toBe(401);
    expect(calls).toHaveLength(2);
  });
  test("a write must declare JSON", async () => {
    const calls = upstream();
    expect((await post(mounted(), submission, { ...asOperator, "content-type": "text/plain" })).status).toBe(415);
    expect(calls).toEqual([]);
  });
  test("with no control token configured, kbbl's loopback policy decides, as it does for the Oakridge proxy", async () => {
    const calls = upstream();
    expect((await mounted({ browserControlToken: undefined }).request("/oakridge/observation/runs/run-1/tasks")).status).toBe(200);
    expect(calls).toHaveLength(1);
  });
});

describe("capabilities stay on the server", () => {
  test("a read uses only the read capability and passes its query through", async () => {
    const calls = upstream();
    const response = await mounted().request(`/oakridge/observation/items/${ITEM}/status?limit=1&answers_offset=2`, { headers: { ...asOperator, cookie: "x=y", "x-custom": "1" } });
    expect(response.status).toBe(200);
    expect(calls[0]).toMatchObject({ method: "GET", authorization: "Bearer read-secret", url: `http://observation.test/v1/items/${ITEM}/status?limit=1&answers_offset=2` });
    expect(Object.keys(calls[0]!.headers)).toEqual(["authorization"]);
  });
  test("a submission uses only the grade capability", async () => {
    const calls = upstream(() => Response.json({ status: "recorded" }, { status: 201 }));
    const response = await post(mounted(), submission);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ status: "recorded" });
    expect(calls[0]).toMatchObject({ method: "POST", authorization: "Bearer grade-secret", url: `http://observation.test/v1/items/${ITEM}/answers` });
  });
  test("a browser's reviewer, evaluator and evidence fields are not forwarded", async () => {
    const calls = upstream();
    await post(mounted(), { ...submission, rationale: "because", corrects_observation_id: "o1", reviewer_id: "someone-else", evaluator_definition_id: "machine", evidence_set_id: "chosen", token: "x" });
    expect(calls[0]?.body).toEqual({ ...submission, rationale: "because", corrects_observation_id: "o1" });
  });
  test("no response carries a token, and upstream response headers do not cross", async () => {
    upstream(() => new Response('{"a":1}', { headers: { "content-type": "application/json", "set-cookie": "leak=1", "x-upstream": "1" } }));
    const response = await mounted().request("/oakridge/observation/reviewer", { headers: asOperator });
    expect(await response.text()).toBe('{"a":1}');
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-upstream")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
  test("the reviewer's identity is read with the capability it binds to", async () => {
    const calls = upstream(() => Response.json({ reviewer_id: "oakridge-operator" }));
    await mounted().request("/oakridge/observation/reviewer", { headers: asOperator });
    expect(calls[0]).toMatchObject({ authorization: "Bearer grade-secret", url: "http://observation.test/v1/reviewer" });
  });
});

describe("only the listed routes forward", () => {
  test("every read maps to its observation route", async () => {
    const calls = upstream();
    const app = mounted();
    const routes: readonly (readonly [string, string])[] = [["/runs/r/grading", "/v1/runs/r/grading-spend"], ["/runs/r/items/at", "/v1/runs/r/items/at"], ["/runs/r/findings", "/v1/runs/r/gradeable-items"],
      ["/runs/r/unlinked-findings", "/v1/runs/r/unlinked-items"], ["/runs/r/unresolved-task-references", "/v1/runs/r/unresolved-references"], ["/runs/r/tasks", "/v1/runs/r/logical-items"],
      ["/runs/r/tasks/T1", "/v1/runs/r/logical-items/T1"], ["/runs/r/tasks/T1/lineage", "/v1/runs/r/logical-items/T1/lineage"], ["/runs/r/drilldown", "/v1/runs/r/composite-drilldown"],
      [`/items/${ITEM}/status`, `/v1/items/${ITEM}/status`], [`/items/${ITEM}/answers`, `/v1/items/${ITEM}/answers`], [`/items/${ITEM}/lineage`, `/v1/items/${ITEM}/lineage`]];
    for (const [route, target] of routes) {
      expect((await app.request(`/oakridge/observation${route}`, { headers: asOperator })).status).toBe(200);
      expect(calls.at(-1)).toMatchObject({ url: `http://observation.test${target}`, authorization: "Bearer read-secret" });
    }
  });
  test("ingest, source and unlisted paths are not reachable", async () => {
    const calls = upstream();
    const app = mounted();
    for (const path of ["/v1/sources/oakridge/events", "/sources/oakridge/events", "/v1/items/x", "/evaluations"])
      expect((await app.request(`/oakridge/observation${path}`, { method: "POST", headers: { ...asOperator, "content-type": "application/json" }, body: "{}" })).status).toBe(404);
    expect(calls).toEqual([]);
  });
});

describe("refusals and outages stay truthful", () => {
  test("observation's refusal keeps its status and body, so the PWA can show its reason", async () => {
    const body = { error: { code: "not_ready", message: "waiting", refusal: { kind: "not_ready", code: "repository_unavailable" } } };
    upstream(() => Response.json(body, { status: 409 }));
    const response = await post(mounted(), submission);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual(body);
  });
  test("an outage is an error and never an acknowledgment", async () => {
    globalThis.fetch = (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch;
    const response = await post(mounted(), submission);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "observation_unreachable" } });
  });
  test("an undeployed service or a missing capability says which", async () => {
    const calls = upstream();
    const none = await mounted({ observation: null }).request("/oakridge/observation/runs/r/tasks", { headers: asOperator });
    expect([none.status, await none.json()]).toMatchObject([503, { error: { code: "observation_not_configured" } }]);
    const noGrade = await post(mounted({ observation: { ...observation, gradeToken: null } }), submission);
    expect([noGrade.status, await noGrade.json()]).toMatchObject([503, { error: { code: "observation_capability_missing" } }]);
    const noRead = await mounted({ observation: { ...observation, readToken: null } }).request("/oakridge/observation/runs/r/tasks", { headers: asOperator });
    expect(noRead.status).toBe(503);
    expect(calls).toEqual([]);
  });
  test("a body that is not a JSON object is refused before forwarding", async () => {
    const calls = upstream();
    const app = mounted();
    expect((await post(app, ["not", "an", "object"])).status).toBe(400);
    expect((await app.request(`/oakridge/observation/items/${ITEM}/answers`, { method: "POST", headers: { ...asOperator, "content-type": "application/json" }, body: "{" })).status).toBe(400);
    expect(calls).toEqual([]);
  });
});
