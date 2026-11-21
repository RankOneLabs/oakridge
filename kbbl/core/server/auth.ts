import { timingSafeEqual } from "node:crypto";
import type { Context, MiddlewareHandler, Next } from "hono";
import type { AuthStatus } from "../auth-wire";

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
  if (LOOPBACK_HOSTS.has(host)) return true;
  // Full 127.0.0.0/8 loopback range.
  const parts = host.split(".");
  return parts.length === 4 && parts[0] === "127";
}

/**
 * Resolves the startup auth policy from host, optional control token, and
 * insecure flag. A configured token is required on every bind, loopback
 * included: on loopback any local process — an agent among them — could
 * otherwise act as the operator through the Oakridge proxy. Throws when the
 * bind host is non-loopback and neither a token nor the explicit insecure
 * escape hatch is configured.
 */
export function resolveStartupAuthPolicy(opts: {
  host: string;
  controlToken: string | undefined;
  allowInsecure: boolean;
}): AuthPolicy {
  const { host, allowInsecure } = opts;
  const controlToken = opts.controlToken?.trim() || undefined;

  if (controlToken) {
    return { mode: "token", token: controlToken };
  }

  if (isLoopbackHost(host)) {
    return { mode: "loopback" };
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

function sameOriginFromHeader(headerValue: string | undefined, requestUrl: string): boolean {
  if (!headerValue) return false;
  try {
    return new URL(headerValue).origin === new URL(requestUrl).origin;
  } catch {
    return false;
  }
}

function hasSameOriginBrowserHeader(c: Context): boolean {
  return (
    sameOriginFromHeader(c.req.header("origin"), c.req.url) ||
    sameOriginFromHeader(c.req.header("referer"), c.req.url)
  );
}

function auditAuthRejection(c: Context, status: 401 | 403, reason: string): void {
  console.warn(
    JSON.stringify({
      kbbl: "control-auth",
      event: "rejected",
      status,
      reason,
      method: c.req.method,
      path: c.req.path,
    }),
  );
}

function unauthorized(c: Context, reason: string, error = "unauthorized"): Response {
  auditAuthRejection(c, 401, reason);
  return c.json({ error }, 401, {
    "www-authenticate": 'Bearer realm="kbbl"',
  }) as Response;
}

function forbidden(c: Context, reason: string): Response {
  auditAuthRejection(c, 403, reason);
  return c.json({ error: "forbidden" }, 403, {
    "www-authenticate": 'Bearer realm="kbbl"',
  }) as Response;
}

// ---- request auth middleware -----------------------------------------------

function verifyControlCredentials(c: Context, token: string): Response | null {
  const authHeader = c.req.header("authorization");
  if (authHeader !== undefined) {
    const space = authHeader.indexOf(" ");
    if (space === -1 || authHeader.slice(0, space).toLowerCase() !== "bearer") {
      return unauthorized(
        c,
        "malformed_authorization",
        "malformed Authorization header, expected: Bearer <token>",
      );
    }
    const presented = authHeader.slice(space + 1);
    if (tokenEquals(presented, token)) {
      return null;
    }
    return forbidden(c, "bearer_token_mismatch");
  }

  const cookieHeader = c.req.header("cookie");
  if (cookieHeader !== undefined) {
    const cookieToken = parseCookieToken(cookieHeader);
    if (cookieToken !== null) {
      if (!hasSameOriginBrowserHeader(c)) {
        return forbidden(c, "cookie_missing_same_origin_header");
      }
      if (tokenEquals(cookieToken, token)) {
        return null;
      }
      return forbidden(c, "cookie_token_mismatch");
    }
  }

  return unauthorized(c, "missing_credentials");
}

export type PublicPath =
  | { readonly kind: "exact"; readonly path: string }
  | { readonly kind: "prefix"; readonly prefix: string };

/** Add each new file in core/pwa/public here or it will return 401 to an anonymous browser. */
export const KBBL_PUBLIC_PATHS: readonly PublicPath[] = [
  { kind: "exact", path: "/auth/status" },
  { kind: "exact", path: "/" },
  { kind: "exact", path: "/index.html" },
  { kind: "exact", path: "/manifest.webmanifest" },
  { kind: "exact", path: "/icon.svg" },
  { kind: "prefix", prefix: "/assets/" },
];

export interface ControlAuthOptions { readonly publicPaths?: readonly PublicPath[] }

export function isPublicRequest(
  request: { readonly method: string; readonly path: string },
  publicPaths: readonly PublicPath[],
): boolean {
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  return publicPaths.some((entry) => entry.kind === "exact"
    ? request.path === entry.path
    : request.path.startsWith(entry.prefix));
}

/**
 * In token mode every request requires a Bearer token or the kbbl_ctrl
 * cookie unless it is a GET/HEAD on the public allow-list.
 * Loopback and insecure-non-loopback modes pass through.
 *
 * - Missing credentials → 401 with WWW-Authenticate: Bearer realm="kbbl"
 * - Malformed Authorization header → 401
 * - Well-formed token/cookie that doesn't match → 403
 */
export function makeControlAuthMiddleware(policy: AuthPolicy, options: ControlAuthOptions = {}): MiddlewareHandler {
  if (policy.mode === "loopback" || policy.mode === "insecure-non-loopback") {
    return async (_c: Context, next: Next) => { await next(); };
  }

  const { token } = policy;

  return async (c: Context, next: Next) => {
    if (isPublicRequest({ method: c.req.method, path: c.req.path }, options.publicPaths ?? [])) {
      await next();
      return;
    }

    const rejection = verifyControlCredentials(c, token);
    if (rejection) return rejection;
    await next();
  };
}

/**
 * Returns a Hono handler for GET /auth/status, which the PWA reads on load to
 * decide whether to ask for the control token. The cookie is HttpOnly, so the
 * page cannot see it; only the server can say whether it is valid.
 */
export function makeAuthStatusHandler(
  policy: AuthPolicy,
): (c: Context) => Response | Promise<Response> {
  return (c: Context) => {
    if (policy.mode !== "token") return c.json({ is_required: false, is_authenticated: true } satisfies AuthStatus);
    const cookieToken = parseCookieToken(c.req.header("cookie") ?? "");
    return c.json({ is_required: true, is_authenticated: cookieToken !== null && tokenEquals(cookieToken, policy.token) } satisfies AuthStatus);
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
