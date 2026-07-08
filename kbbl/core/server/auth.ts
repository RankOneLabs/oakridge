import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";

// ---- startup policy -------------------------------------------------------

export type AuthPolicy =
  | { mode: "loopback" }
  | { mode: "token"; token: string }
  | { mode: "insecure-non-loopback" };

const LOOPBACK_HOSTS = new Set([
  "127.0.0.1",
  "::1",
  "localhost",
  "0:0:0:0:0:0:0:1",
  "[::1]",
]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * Resolves the startup auth policy from host, optional control token, and
 * insecure flag. Throws when the bind host is non-loopback and neither a
 * token nor the explicit insecure escape hatch is configured.
 */
export function resolveStartupAuthPolicy(opts: {
  host: string;
  controlToken: string | undefined;
  allowInsecure: boolean;
}): AuthPolicy {
  const { host, allowInsecure } = opts;
  const controlToken = opts.controlToken?.trim() || undefined;

  if (isLoopbackHost(host)) {
    return { mode: "loopback" };
  }

  if (controlToken) {
    return { mode: "token", token: controlToken };
  }

  if (allowInsecure) {
    return { mode: "insecure-non-loopback" };
  }

  throw new Error(
    `kbbl: non-loopback bind host=${host} requires OAKRIDGE_CONTROL_TOKEN or ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1`,
  );
}

// ---- token comparison -----------------------------------------------------

function tokenEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

// ---- cookie helpers -------------------------------------------------------

const COOKIE_NAME = "kbbl_ctrl";

function parseCookieToken(cookieHeader: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name === COOKIE_NAME) {
      return part.slice(eq + 1).trim();
    }
  }
  return null;
}

// ---- request auth middleware -----------------------------------------------

/**
 * Returns a Hono middleware that enforces Bearer/cookie auth on all
 * non-GET/HEAD requests except /hook/* adapter routes (which are
 * loopback-verified by the runtime adapter).
 *
 * In loopback or insecure-non-loopback mode returns a pass-through middleware.
 *
 * - Missing credentials → 401 with WWW-Authenticate: Bearer realm="kbbl"
 * - Malformed Authorization header → 401
 * - Well-formed token/cookie that doesn't match → 403
 */
export function makeControlAuthMiddleware(policy: AuthPolicy): MiddlewareHandler {
  if (policy.mode === "loopback" || policy.mode === "insecure-non-loopback") {
    return async (_c: Context, next: Next) => { await next(); };
  }

  const { token } = policy;

  return async (c: Context, next: Next) => {
    const method = c.req.method;

    // Safe methods and hook adapter routes pass through without auth.
    if (method === "GET" || method === "HEAD") {
      await next();
      return;
    }
    if (c.req.path.startsWith("/hook/")) {
      await next();
      return;
    }

    const authHeader = c.req.header("authorization");
    if (authHeader !== undefined) {
      const space = authHeader.indexOf(" ");
      if (space === -1 || authHeader.slice(0, space).toLowerCase() !== "bearer") {
        return c.json(
          { error: "malformed Authorization header, expected: Bearer <token>" },
          401,
          { "www-authenticate": 'Bearer realm="kbbl"' },
        );
      }
      const presented = authHeader.slice(space + 1);
      if (tokenEquals(presented, token)) {
        await next();
        return;
      }
      return c.json({ error: "forbidden" }, 403, {
        "www-authenticate": 'Bearer realm="kbbl"',
      });
    }

    const cookieHeader = c.req.header("cookie");
    if (cookieHeader !== undefined) {
      const cookieToken = parseCookieToken(cookieHeader);
      if (cookieToken !== null) {
        if (tokenEquals(cookieToken, token)) {
          await next();
          return;
        }
        return c.json({ error: "forbidden" }, 403, {
          "www-authenticate": 'Bearer realm="kbbl"',
        });
      }
    }

    return c.json({ error: "unauthorized" }, 401, {
      "www-authenticate": 'Bearer realm="kbbl"',
    });
  };
}

/**
 * Returns a Hono handler for POST /auth/cookie that validates a Bearer
 * token and establishes an HttpOnly SameSite=Lax cookie.
 *
 * In loopback or insecure mode this is a no-op that always succeeds
 * (the cookie isn't needed when auth is off).
 */
export function makeCookieHandler(
  policy: AuthPolicy,
): (c: Context) => Response | Promise<Response> {
  if (policy.mode === "loopback" || policy.mode === "insecure-non-loopback") {
    return (c: Context) => c.json({ ok: true });
  }

  const { token } = policy;

  return (c: Context) => {
    const authHeader = c.req.header("authorization");
    if (!authHeader) {
      return c.json(
        { error: "unauthorized" },
        401,
        { "www-authenticate": 'Bearer realm="kbbl"' },
      ) as Response;
    }
    const space = authHeader.indexOf(" ");
    if (space === -1 || authHeader.slice(0, space).toLowerCase() !== "bearer") {
      return c.json(
        { error: "malformed Authorization header" },
        401,
        { "www-authenticate": 'Bearer realm="kbbl"' },
      ) as Response;
    }
    const presented = authHeader.slice(space + 1);
    if (!tokenEquals(presented, token)) {
      return c.json(
        { error: "forbidden" },
        403,
        { "www-authenticate": 'Bearer realm="kbbl"' },
      ) as Response;
    }
    const cookieValue = `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/`;
    return c.json({ ok: true }, 200, { "set-cookie": cookieValue }) as Response;
  };
}
