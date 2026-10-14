import type { MiddlewareHandler } from "hono";
import { createHash, timingSafeEqual } from "node:crypto";
import { matchRoute } from "./routes";
import { errorResponse, ForbiddenError, UnauthorizedError, UnknownRouteError } from "./errors";
import type { BrowserWritePolicy } from "./browser-write-policy";
import type { Writer } from "../core-client/core-types";

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
  /** Bound to loopback with no token: open only to requests addressed to a loopback name. */
  | { readonly kind: "loopback_open" }
  /** Bound off loopback with no token, on the operator's explicit override. */
  | { readonly kind: "insecure_open" }
  | { readonly kind: "token_required"; readonly token: string }
  | { readonly kind: "refused"; readonly detail: string };
/** The access a started control plane serves under: any but a refusal. */
export type ServedControlPlaneAccess = Exclude<ControlPlaneAccess, { readonly kind: "refused" }>;

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
  if (input.allow_insecure_non_loopback) return { kind: "insecure_open" };
  return {
    kind: "refused",
    detail: `OAKRIDGE_CONTROL_TOKEN is required when binding to '${input.host}': a non-loopback bind exposes run launch, gate resume, and artifact emission to the network. `
      + "Set a token, bind to 127.0.0.1, or set ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 to accept the risk explicitly.",
  };
};

const IPV4_LOOPBACK = /^127(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const HOST_HEADER = /^(?<name>\[[^\]]*\]|[^:[\]]+)(?::\d{1,5})?$/;
/** Whether a Host header names loopback: localhost, 127.0.0.0/8 or [::1], with or without a port. */
export function isLoopbackHostHeader(host: string | null): boolean {
  const name = host === null ? undefined : HOST_HEADER.exec(host.trim().toLowerCase())?.groups?.name;
  if (name === undefined) return false;
  return name === "localhost" || name === "[::1]" || IPV4_LOOPBACK.test(name);
}

/**
 * DNS rebinding: a page on any origin can rebind its own name to 127.0.0.1
 * and read a loopback-open control plane same-origin (a GET sends no Origin,
 * so the browser write policy never sees it). The browser still sends the
 * page's name as Host, so a loopback bind answers only requests addressed to
 * a loopback name. kbbl's proxy addresses the backend by its loopback URL.
 */
export const loopbackHostMiddleware = (): MiddlewareHandler => async (context, next) =>
  isLoopbackHostHeader(context.req.header("host") ?? new URL(context.req.url).host) ? next() : errorResponse(new ForbiddenError("host forbidden"));

export const requiresControlToken = (method: string, path = "/runs"): boolean =>
  matchRoute(method, path)?.authority === "operator";

function equalToken(header: string | undefined, token: string): boolean {
  const supplied = createHash("sha256").update(header ?? "").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  return timingSafeEqual(supplied, expected);
}

/** Stable, non-secret identifier for the credential that passed control auth.
 * The request body has no role in choosing the event writer. */
export function operatorWriterFromCredential(request: Request): Extract<Writer, { readonly kind: "operator" }> {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const credential = bearer ?? controlCookie(request.headers.get("cookie"));
  return { kind: "operator", subject: credential
    ? `credential:${createHash("sha256").update(credential).digest("hex").slice(0, 24)}`
    : "local-control" };
}

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

/**
 * Whether a request on the publish route carries the operator's credential
 * rather than a session secret (part 1 §12, D2: the operator edits an
 * artifact). With a token, the control credential decides. Without one the
 * control plane is loopback-open, as for every operator route, and a request
 * that presents no secret is the operator's; a secret that resolves to no
 * session is refused, never taken for the operator.
 */
export const operatorCredentialCheck = (token: string | null, policy?: BrowserWritePolicy) =>
  (request: Request): boolean => token === null
    ? request.headers.get("authorization") === null
    : isValidControlRequest(request, token, policy);

/** Fail closed: a request no route in the table classifies is refused, even where a handler is registered. */
export const classifiedRoutesMiddleware = (): MiddlewareHandler => async (context, next) =>
  matchRoute(context.req.method, context.req.path) ? next() : errorResponse(new UnknownRouteError("unclassified route"));

export const controlTokenMiddleware = (token: string, policy?: BrowserWritePolicy): MiddlewareHandler => async (context, next) => {
  if (!requiresControlToken(context.req.method, context.req.path)) return next();
  if (!isValidControlRequest(context.req.raw, token, policy)) return errorResponse(new UnauthorizedError("control credential required"));
  return next();
};
