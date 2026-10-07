import type { MiddlewareHandler } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { matchRoute } from "./routes";
import type { BrowserWritePolicy } from "./browser-write-policy";

/**
 * The control plane's bind policy, decided once at startup.
 *
 * The Rust core refused to start when bound off loopback without
 * `OAKRIDGE_CONTROL_TOKEN`, and enforced Bearer on writes. The DBOS backend
 * inherited the loopback default but not the invariant, so
 * `OAKRIDGE_DBOS_HOST=0.0.0.0` silently exposed an unauthenticated
 * launch/gate/artifact-emit surface — and kbbl's proxy was already injecting a
 * token nothing checked. Refusing to start is the half that cannot be
 * retrofitted by a reverse proxy, so it is restored here.
 */
export type ControlPlaneAccess =
  | { readonly kind: "loopback_open" }
  | { readonly kind: "token_required"; readonly token: string }
  | { readonly kind: "refused"; readonly detail: string };

export interface ControlPlaneAccessInput {
  readonly host: string;
  readonly token: string | undefined;
  /** Explicit operator override for a trusted network with no token. */
  readonly allow_insecure_non_loopback: boolean;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1", "localhost", "[::1]"]);

export const isLoopbackHost = (host: string): boolean => LOOPBACK_HOSTS.has(host.trim().toLowerCase());

export const selectControlPlaneAccess = (input: ControlPlaneAccessInput): ControlPlaneAccess => {
  const token = input.token?.trim();
  if (token) return { kind: "token_required", token };
  if (isLoopbackHost(input.host)) return { kind: "loopback_open" };
  if (input.allow_insecure_non_loopback) return { kind: "loopback_open" };
  return {
    kind: "refused",
    detail: `OAKRIDGE_CONTROL_TOKEN is required when binding to '${input.host}': a non-loopback bind exposes run launch, gate resume, and artifact emission to the network. `
      + "Set a token, bind to 127.0.0.1, or set ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 to accept the risk explicitly.",
  };
};

export const requiresControlToken = (method: string, path = "/runs"): boolean =>
  matchRoute(method, path)?.authority === "operator";

function equalToken(header: string | undefined, token: string): boolean {
  const supplied = createHash("sha256").update(header ?? "").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(supplied, expected);
}
export const isValidControlToken = equalToken;

function controlCookie(header: string | null): string | null {
  for (const part of (header ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === "kbbl_ctrl") return value.join("=");
  }
  return null;
}

/** The backend and proxy accept the same token, whether carried by Bearer or the PWA's control cookie. */
export function isValidControlRequest(request: Pick<Request, "method" | "headers">, token: string,
  policy: BrowserWritePolicy = { allowed_origins: new Set() }): boolean {
  const authorization = request.headers.get("authorization");
  if (authorization !== null) return equalToken(authorization, token);
  const cookie = controlCookie(request.headers.get("cookie"));
  if (cookie === null || !equalToken(`Bearer ${cookie}`, token)) return false;
  if (request.method === "GET" || request.method === "HEAD") return true;
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!origin) return false;
  try { return policy.allowed_origins.has(new URL(origin).origin); }
  catch { return false; }
}

export const controlTokenMiddleware = (token: string, policy?: BrowserWritePolicy): MiddlewareHandler => async (context, next) => {
  if (!requiresControlToken(context.req.method, context.req.path)) return next();
  if (!isValidControlRequest(context.req.raw, token, policy)) return context.json({ error: "unauthorized" }, 401);
  return next();
};
