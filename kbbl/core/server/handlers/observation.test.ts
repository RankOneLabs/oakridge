import { expect, test } from "bun:test";
import { Hono } from "hono";
import { mountObservationRoutes } from "./observation";
import { createObservationClient } from "../observation/client";
import type { AuthPolicy } from "../auth";

const config = { base_url: "http://private-observation.invalid", namespace: "test",
  read_token: "private-read", grade_token: "private-grade" };
const client = createObservationClient(config, (async (request: Request | URL | string) => {
  const path = new URL(String(request)).pathname;
  return Response.json(path.includes("blind-assignments") ? { items: [] }
    : path.includes("evidence-sets") ? { evidence_set_id: "e", evidence_refs: [], is_incomplete: false, digest: "d" }
    : { occurrence_id: "o", relations: [], unresolved: [], total: 0 });
}));
function app(policy: AuthPolicy): Hono {
  const instance = new Hono();
  mountObservationRoutes(instance, { authPolicy: policy, client, namespace: "test" });
  return instance;
}

test("token policy rejects an unauthenticated observation GET", async () => {
  const response = await app({ mode: "token", token: "control" }).request("/observation/items/o/lineage");
  expect(response.status).toBe(401);
});

test("insecure bind refuses blind and evidence surfaces but serves metadata", async () => {
  const instance = app({ mode: "insecure-non-loopback" });
  const statuses = await Promise.all([
    instance.request("/observation/blind/assignments", { method: "POST" }),
    instance.request("/observation/evidence/e"),
    instance.request("/observation/items/o/lineage"),
  ]);
  expect(statuses.map((response) => response.status)).toEqual([403, 403, 200]);
});

test("loopback serves observation surfaces and response bodies omit server credentials", async () => {
  const instance = app({ mode: "loopback" });
  const responses = await Promise.all([
    instance.request("/observation/blind/assignments", { method: "POST" }),
    instance.request("/observation/evidence/e"),
    instance.request("/observation/items/o/lineage"),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200, 200]);
  for (const response of responses) {
    const body = await response.text();
    for (const secret of [config.read_token, config.grade_token, config.base_url]) expect(body).not.toContain(secret);
    expect(response.headers.get("cache-control")).toBe("no-store");
  }
});

test("no blind retrieval route is mounted as GET", () => {
  const routes = app({ mode: "loopback" }).routes;
  expect(routes.filter((route) => route.method === "GET" && route.path.startsWith("/observation/blind/"))).toHaveLength(0);
});
