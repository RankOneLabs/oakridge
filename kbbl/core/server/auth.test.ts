import { describe, expect, test } from "bun:test";
import { Hono, type Context } from "hono";

import {
  isLoopbackHost,
  isPublicRequest,
  KBBL_PUBLIC_PATHS,
  makeAuthStatusHandler,
  makeControlAuthMiddleware,
  makeCookieHandler,
  resolveStartupAuthPolicy,
  type AuthPolicy,
} from "./auth";

// ---- resolveStartupAuthPolicy -----------------------------------------------

describe("resolveStartupAuthPolicy — startup guard", () => {
  test("127.0.0.1 without token starts successfully as loopback", () => {
    const policy = resolveStartupAuthPolicy({
      host: "127.0.0.1",
      controlToken: undefined,
      allowInsecure: false,
    });
    expect(policy.mode).toBe("loopback");
  });

  test("0.0.0.0 without token or insecure flag throws at startup", () => {
    expect(() =>
      resolveStartupAuthPolicy({
        host: "0.0.0.0",
        controlToken: undefined,
        allowInsecure: false,
      }),
    ).toThrow(/non-loopback bind/);
  });

  test("0.0.0.0 with ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 starts with insecure-non-loopback marker", () => {
    const policy = resolveStartupAuthPolicy({
      host: "0.0.0.0",
      controlToken: undefined,
      allowInsecure: true,
    });
    expect(policy.mode).toBe("insecure-non-loopback");
  });

  test("0.0.0.0 with OAKRIDGE_CONTROL_TOKEN starts in token mode", () => {
    const policy = resolveStartupAuthPolicy({
      host: "0.0.0.0",
      controlToken: "s3cr3t",
      allowInsecure: false,
    });
    expect(policy).toEqual({ mode: "token", token: "s3cr3t" });
  });

  // On loopback any local process, an agent among them, could otherwise act as
  // the operator through the Oakridge proxy, which presents the core token.
  test("127.0.0.1 with OAKRIDGE_CONTROL_TOKEN starts in token mode", () => {
    const policy = resolveStartupAuthPolicy({
      host: "127.0.0.1",
      controlToken: "s3cr3t",
      allowInsecure: false,
    });
    expect(policy).toEqual({ mode: "token", token: "s3cr3t" });
  });

  test("::1 without token is treated as loopback", () => {
    const policy = resolveStartupAuthPolicy({
      host: "::1",
      controlToken: undefined,
      allowInsecure: false,
    });
    expect(policy.mode).toBe("loopback");
  });

  test("localhost without token is treated as loopback", () => {
    const policy = resolveStartupAuthPolicy({
      host: "localhost",
      controlToken: undefined,
      allowInsecure: false,
    });
    expect(policy.mode).toBe("loopback");
  });

  test("concrete LAN address without token or insecure flag throws", () => {
    expect(() =>
      resolveStartupAuthPolicy({
        host: "192.168.1.100",
        controlToken: undefined,
        allowInsecure: false,
      }),
    ).toThrow();
  });

  test("tailnet address with token resolves to token mode", () => {
    const policy = resolveStartupAuthPolicy({
      host: "100.64.0.1",
      controlToken: "my-token",
      allowInsecure: false,
    });
    expect(policy).toEqual({ mode: "token", token: "my-token" });
  });

  test("whitespace-only token is treated as absent (throws on non-loopback)", () => {
    expect(() =>
      resolveStartupAuthPolicy({
        host: "0.0.0.0",
        controlToken: "   ",
        allowInsecure: false,
      }),
    ).toThrow();
  });
});

describe("isLoopbackHost", () => {
  test("recognizes IPv4 loopback", () => expect(isLoopbackHost("127.0.0.1")).toBe(true));
  test("recognizes IPv6 loopback", () => expect(isLoopbackHost("::1")).toBe(true));
  test("recognizes localhost", () => expect(isLoopbackHost("localhost")).toBe(true));
  test("rejects 0.0.0.0", () => expect(isLoopbackHost("0.0.0.0")).toBe(false));
  test("rejects LAN address", () => expect(isLoopbackHost("192.168.1.1")).toBe(false));
});

describe("isPublicRequest", () => {
  test.each([
    ["GET", "/auth/status", true],
    ["HEAD", "/assets/index-abc.js", true],
    ["GET", "/", true],
    ["POST", "/auth/status", false],
    ["GET", "/sessions", false],
    ["GET", "/assetsx", false],
  ] as const)("%s %s has public access %s", (method, path, isPublic) => {
    expect(isPublicRequest({ method, path }, KBBL_PUBLIC_PATHS)).toBe(isPublic);
  });

  test("an empty allow-list denies even an otherwise public path", () => {
    expect(isPublicRequest({ method: "GET", path: "/" }, [])).toBe(false);
  });
});

// ---- makeControlAuthMiddleware -----------------------------------------------

function buildApp(policy: AuthPolicy): Hono {
  const app = new Hono();
  app.use("/*", makeControlAuthMiddleware(policy, { publicPaths: KBBL_PUBLIC_PATHS }));
  const ok = (c: Context) => c.json({ ok: true });
  for (const path of ["/auth/status", "/assets/index-abc.js", "/", "/sessions", "/sessions/:sid/items", "/directories", "/live", "/read"]) {
    app.get(path, ok);
  }
  app.post("/write", ok);
  app.delete("/write", ok);
  app.all("/hook/*", ok);
  return app;
}

describe("makeControlAuthMiddleware — loopback mode", () => {
  const app = buildApp({ mode: "loopback" });

  test("GET passes through without auth", async () => {
    const res = await app.request("/read");
    expect(res.status).toBe(200);
  });

  test("POST passes through without auth", async () => {
    const res = await app.request("/write", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("makeControlAuthMiddleware — insecure-non-loopback mode", () => {
  const app = buildApp({ mode: "insecure-non-loopback" });

  test("POST passes through without auth", async () => {
    const res = await app.request("/write", { method: "POST" });
    expect(res.status).toBe(200);
  });
});

describe("makeControlAuthMiddleware — token mode", () => {
  const TOKEN = "test-secret-token";
  const app = buildApp({ mode: "token", token: TOKEN });

  test("GET /sessions/:sid/items without credentials returns a Bearer challenge", async () => {
    const res = await app.request("/sessions/sid-1/items");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  for (const path of ["/sessions", "/directories", "/read", "/live"]) {
    test.each(["GET", "HEAD"])("%s " + path + " without credentials returns 401", async (method) => {
      expect((await app.request(path, { method })).status).toBe(401);
    });
  }

  test.each([
    ["POST", "/hook/approval"],
    ["GET", "/hook/anything"],
    ["GET", "/no-such-route"],
    ["GET", "/assets/%2e%2e/sessions"],
  ])("%s %s without credentials returns 401", async (method, path) => {
    expect((await app.request(path, { method })).status).toBe(401);
  });

  test.each([
    ["GET", "/auth/status"],
    ["GET", "/"],
    ["GET", "/assets/index-abc.js"],
    ["HEAD", "/assets/index-abc.js"],
  ])("%s %s without credentials returns 200", async (method, path) => {
    expect((await app.request(path, { method })).status).toBe(200);
  });

  test("GET /sessions/:sid/items with a Bearer token returns 200", async () => {
    const res = await app.request("/sessions/sid-1/items", {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("GET /live with a valid cookie and same-origin Referer returns 200", async () => {
    const res = await app.request("/live", {
      headers: { cookie: `kbbl_ctrl=${TOKEN}`, referer: "http://localhost/" },
    });
    expect(res.status).toBe(200);
  });

  test("GET /sessions with a valid cookie but no same-origin header returns 403", async () => {
    const res = await app.request("/sessions", { headers: { cookie: `kbbl_ctrl=${TOKEN}` } });
    expect(res.status).toBe(403);
  });

  test("GET /sessions with the wrong Bearer token returns 403", async () => {
    const res = await app.request("/sessions", { headers: { authorization: "Bearer wrong-token" } });
    expect(res.status).toBe(403);
  });

  test("POST without credentials returns 401 with WWW-Authenticate", async () => {
    const res = await app.request("/write", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("POST with malformed Authorization header returns 401", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  test("POST with wrong Bearer token returns 403", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("POST with correct Bearer token succeeds", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("DELETE with correct Bearer token succeeds", async () => {
    const res = await app.request("/write", {
      method: "DELETE",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
  });

  test("POST with correct cookie token succeeds", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: `kbbl_ctrl=${TOKEN}; other=val`, origin: "http://localhost" },
    });
    expect(res.status).toBe(200);
  });

  test("POST with correct cookie token but no same-origin header returns 403", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: `kbbl_ctrl=${TOKEN}` },
    });
    expect(res.status).toBe(403);
  });

  test("POST with correct cookie token from another origin returns 403", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: `kbbl_ctrl=${TOKEN}`, origin: "https://example.invalid" },
    });
    expect(res.status).toBe(403);
  });

  test("POST with wrong cookie token returns 403", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: "kbbl_ctrl=wrong-token", origin: "http://localhost" },
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe("forbidden");
  });

  test("POST with unrelated cookie (no kbbl_ctrl) returns 401", async () => {
    const res = await app.request("/write", {
      method: "POST",
      headers: { cookie: "session=abc123" },
    });
    expect(res.status).toBe(401);
  });
});

// ---- makeCookieHandler -------------------------------------------------------

describe("makeCookieHandler — loopback mode", () => {
  test("always returns ok without setting cookie", async () => {
    const app = new Hono();
    const policy: AuthPolicy = { mode: "loopback" };
    app.post("/auth/cookie", makeCookieHandler(policy));
    const res = await app.request("/auth/cookie", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("makeCookieHandler — token mode", () => {
  const TOKEN = "test-secret-token";

  function buildCookieApp(): Hono {
    const app = new Hono();
    const policy: AuthPolicy = { mode: "token", token: TOKEN };
    app.post("/auth/cookie", makeCookieHandler(policy));
    return app;
  }

  test("missing Authorization returns 401", async () => {
    const app = buildCookieApp();
    const res = await app.request("/auth/cookie", { method: "POST" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
  });

  test("wrong token returns 403", async () => {
    const app = buildCookieApp();
    const res = await app.request("/auth/cookie", {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
    });
    expect(res.status).toBe(403);
  });

  test("correct token sets HttpOnly SameSite=Lax cookie", async () => {
    const app = buildCookieApp();
    const res = await app.request("/auth/cookie", {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("kbbl_ctrl=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });
});

describe("GET /auth/status", () => {
  const statusOf = async (policy: AuthPolicy, cookie?: string) => {
    const app = new Hono();
    app.get("/auth/status", makeAuthStatusHandler(policy));
    return (await app.request("/auth/status", cookie ? { headers: { cookie } } : {})).json();
  };

  test("reports a token-mode kbbl's credential as required, and whether the cookie carries it", async () => {
    const policy: AuthPolicy = { mode: "token", token: "tok" };
    expect([await statusOf(policy), await statusOf(policy, "kbbl_ctrl=wrong"), await statusOf(policy, "kbbl_ctrl=tok")]).toEqual([
      { is_required: true, is_authenticated: false },
      { is_required: true, is_authenticated: false },
      { is_required: true, is_authenticated: true },
    ]);
  });

  test("reports no credential required without a token", async () => {
    expect(await statusOf({ mode: "loopback" })).toEqual({ is_required: false, is_authenticated: true });
  });
});
