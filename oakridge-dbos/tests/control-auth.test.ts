/**
 * The control plane's bind policy. The Rust core refused to start on a
 * non-loopback bind without a token; the DBOS backend kept the loopback default
 * but dropped the invariant, so `OAKRIDGE_DBOS_HOST=0.0.0.0` opened an
 * unauthenticated launch/gate/artifact-emit surface.
 */
import { Hono } from "hono";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HTTP_ROUTES } from "../src/http/routes";
import { createHttpApp, type DefinitionApiDependencies } from "../src/http/app";
import { browserWritePolicy } from "../src/http/browser-write-policy";

import { controlTokenMiddleware, isLoopbackHost, isLoopbackHostHeader, requiresControlToken, selectControlPlaneAccess,
  type ServedControlPlaneAccess } from "../src/http/control-auth";

const access = (host: string, token?: string, allow_insecure_non_loopback = false) =>
  selectControlPlaneAccess({ host, token, allow_insecure_non_loopback });

test("a loopback bind needs no token, which is what makes the default safe", () => {
  expect(access("127.0.0.1")).toEqual({ kind: "loopback_open" });
  expect(access("::1")).toEqual({ kind: "loopback_open" });
  expect(access("localhost")).toEqual({ kind: "loopback_open" });
});

test("a non-loopback bind without a token is refused rather than quietly opened", () => {
  const refusal = access("0.0.0.0");
  expect(refusal.kind).toBe("refused");
  if (refusal.kind !== "refused") return;
  expect(refusal.detail).toContain("OAKRIDGE_CONTROL_TOKEN is required");
  expect(refusal.detail).toContain("0.0.0.0");
});

test("a non-loopback bind with a token starts and demands that token", () => {
  expect(access("0.0.0.0", "secret")).toEqual({ kind: "token_required", token: "secret" });
});

test("a whitespace-only token is no token at all", () => {
  expect(access("0.0.0.0", "   ").kind).toBe("refused");
});

test("an operator can accept the risk explicitly, but never by accident", () => {
  expect(access("0.0.0.0", undefined, true)).toEqual({ kind: "insecure_open" });
  expect(isLoopbackHost("192.168.50.10")).toBe(false);
});

test("operator reads and writes require the token", () => {
  expect(requiresControlToken("GET", "/api/runs")).toBe(true);
  expect(requiresControlToken("HEAD", "/api/runs")).toBe(true);
  expect(requiresControlToken("GET", "/health")).toBe(false);
  expect(requiresControlToken("POST", "/api/runs")).toBe(true);
  expect(requiresControlToken("DELETE", "/runs/r1")).toBe(true);
});

const servedAs = (control_token: string | null): ServedControlPlaneAccess =>
  control_token === null ? { kind: "loopback_open" } : { kind: "token_required", token: control_token };
const httpApp = (control_token: string | null, access: ServedControlPlaneAccess = servedAs(control_token)) =>
  createHttpApp({ ...({} as DefinitionApiDependencies), application_version: "test", access, write_policy: browserWritePolicy([]) });
const registered = (app: ReturnType<typeof createHttpApp>) =>
  app.routes.filter((route) => route.method !== "ALL").map((route) => `${route.method} ${route.path}`).sort();

test("every registered route is classified in the route table, and every classified route is registered", () => {
  expect(registered(httpApp(null))).toEqual(HTTP_ROUTES.map((route) => `${route.method} ${route.path}`).sort());
});

test("a registered route the table does not classify is refused before its handler, with or without a token", async () => {
  const reached: string[] = [];
  const statuses = await Promise.all([null, "secret"].map(async (token) => {
    const app = httpApp(token);
    app.get("/api/unclassified", (context) => { reached.push(String(token)); return context.json({ ok: true }); });
    return (await app.request("/api/unclassified", { headers: { authorization: "Bearer secret" } })).status;
  }));
  expect({ statuses, reached }).toEqual({ statuses: [404, 404], reached: [] });
});

test("only operator routes demand the control token; publish authenticates with its session secret", () => {
  expect(HTTP_ROUTES.filter((route) => route.authority !== "operator").map((route) => `${route.authority} ${route.method} ${route.path}`))
    .toEqual(["open GET /health", "session PUT /api/runs/:run_id/units/:unit_id/artifacts/:artifact"]);
});

test("control auth has no early-exit token comparison", () => {
  const source = readFileSync(new URL("../src/http/control-auth.ts", import.meta.url), "utf8");
  expect(source).toContain("timingSafeEqual");
  expect(source).not.toMatch(/header\s*!==\s*`Bearer/);
});

test("a write without the token is rejected before it reaches a handler", async () => {
  let reached = false;
  const app = new Hono();
  app.use("*", controlTokenMiddleware("secret"));
  app.post("/api/runs", (context) => { reached = true; return context.json({ ok: true }); });

  expect((await app.request("/api/runs", { method: "POST" })).status).toBe(401);
  expect(reached).toBe(false);
  expect((await app.request("/api/runs", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await app.request("/api/runs", { method: "POST", headers: { authorization: "Bearer secret" } })).status).toBe(200);
  expect(reached).toBe(true);
});

test("a Host header names loopback only as localhost, 127.0.0.0/8 or [::1], with or without a port", () => {
  const hosts = ["localhost", "LOCALHOST:8790", "127.0.0.1:8790", "127.1.2.3", "[::1]", "[::1]:8790",
    "evil.example", "evil.example:8790", "localhost.evil.example", "127.0.0.1.evil.example", "0.0.0.0:8790", "192.168.50.10", "[::2]", "localhost:port"];
  expect(Object.fromEntries(hosts.map((host) => [host, isLoopbackHostHeader(host)]))).toEqual({
    "localhost": true, "LOCALHOST:8790": true, "127.0.0.1:8790": true, "127.1.2.3": true, "[::1]": true, "[::1]:8790": true,
    "evil.example": false, "evil.example:8790": false, "localhost.evil.example": false, "127.0.0.1.evil.example": false,
    "0.0.0.0:8790": false, "192.168.50.10": false, "[::2]": false, "localhost:port": false });
});

/** A request's status; one that passes the host check reaches the route table, which answers 404 for this unclassified path. */
const statusAddressedTo = async (app: ReturnType<typeof createHttpApp>, host: string, path = "/api/unclassified"): Promise<number> =>
  (await app.request(`http://127.0.0.1:8790${path}`, { headers: { host } })).status;

test("a loopback-open control plane refuses a request addressed to a rebound name, reads included", async () => {
  const app = httpApp(null);
  const refused = await app.request("http://127.0.0.1:8790/api/runs", { headers: { host: "rebound.example:8790" } });
  expect({ refused: refused.status, body: await refused.json(), loopback: await statusAddressedTo(app, "127.0.0.1:8790"),
    localhost: await statusAddressedTo(app, "localhost:8790"), ipv6: await statusAddressedTo(app, "[::1]:8790"),
    rebound_health: await statusAddressedTo(app, "rebound.example:8790", "/health") })
    .toEqual({ refused: 403, body: { error: "host forbidden", code: "forbidden" }, loopback: 404, localhost: 404, ipv6: 404, rebound_health: 403 });
});

test("a token or an explicitly insecure bind serves requests addressed to any name", async () => {
  const statuses = await Promise.all([{ kind: "token_required", token: "secret" } as const, { kind: "insecure_open" } as const]
    .map((access) => statusAddressedTo(httpApp(null, access), "otto.tailnet.example:8790")));
  expect(statuses).toEqual([404, 404]);
});
