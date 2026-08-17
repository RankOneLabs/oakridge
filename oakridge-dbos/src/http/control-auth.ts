import type { MiddlewareHandler } from "hono";

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

/**
 * Reads are left open: they carry no authority, the dashboard polls them
 * constantly, and the event stream cannot send an Authorization header from
 * `EventSource`. Everything that changes state requires the Bearer token.
 */
export const requiresControlToken = (method: string): boolean => method !== "GET" && method !== "HEAD" && method !== "OPTIONS";

export const controlTokenMiddleware = (token: string): MiddlewareHandler => async (context, next) => {
  if (!requiresControlToken(context.req.method)) return next();
  const header = context.req.header("authorization");
  if (header !== `Bearer ${token}`) return context.json({ error: "unauthorized" }, 401);
  return next();
};
