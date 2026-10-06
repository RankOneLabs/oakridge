/**
 * The control plane's bind policy. The Rust core refused to start on a
 * non-loopback bind without a token; the DBOS backend kept the loopback default
 * but dropped the invariant, so `OAKRIDGE_DBOS_HOST=0.0.0.0` opened an
 * unauthenticated launch/gate/artifact-emit surface.
 */
import { Hono } from "hono";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { activeRoutes, HTTP_ROUTES } from "../src/http/routes";

import { controlTokenMiddleware, isLoopbackHost, requiresControlToken, selectControlPlaneAccess } from "../src/http/control-auth";

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
  expect(access("0.0.0.0", undefined, true)).toEqual({ kind: "loopback_open" });
  expect(isLoopbackHost("192.168.50.10")).toBe(false);
});

test("stage-one reads stay open and operator writes require the token", () => {
  expect(requiresControlToken("GET", "/api/inbox")).toBe(false);
  expect(requiresControlToken("HEAD", "/api/inbox")).toBe(false);
  expect(requiresControlToken("POST", "/runs")).toBe(true);
  expect(requiresControlToken("DELETE", "/runs/r1")).toBe(true);
});

test("the route table enumerates every registered Hono endpoint", () => {
  const files = ["../src/http/app.ts", "../src/http/selected-publication.ts", "../src/http/selected-evidence.ts", "../src/runtime/compose.ts"];
  const actual = files.flatMap((file) => [...readFileSync(new URL(file, import.meta.url), "utf8").matchAll(/app\.(get|post|put|delete)\("([^"]+)"/g)]
    .map((match) => `${match[1]?.toUpperCase()} ${match[2]}`)).sort();
  expect(actual).toEqual(HTTP_ROUTES.map((route) => `${route.method} ${route.path}`).sort());
});

test("raw ingress is absent unless enabled", () => {
  expect(activeRoutes(false).some((route) => route.path.endsWith("/decide"))).toBe(false);
  expect(activeRoutes(true).some((route) => route.path.endsWith("/decide"))).toBe(true);
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
  app.post("/runs", (context) => { reached = true; return context.json({ ok: true }); });

  expect((await app.request("/runs", { method: "POST" })).status).toBe(401);
  expect(reached).toBe(false);
  expect((await app.request("/runs", { method: "POST", headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect((await app.request("/runs", { method: "POST", headers: { authorization: "Bearer secret" } })).status).toBe(200);
  expect(reached).toBe(true);
});
