/** The process HTTP contract. The proxy imports this only from its server code. */
export type RouteAuthority = "open" | "operator" | "execution";
export interface HttpRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly authority: RouteAuthority;
  readonly raw_ingress?: true;
}

export const HTTP_ROUTES: readonly HttpRoute[] = [
  { method: "GET", path: "/health", authority: "open" },
  { method: "POST", path: "/runs", authority: "operator" },
  { method: "GET", path: "/api/runs", authority: "operator" },
  { method: "GET", path: "/api/definitions", authority: "operator" },
  { method: "POST", path: "/api/definitions", authority: "operator" },
  { method: "GET", path: "/runs/:run_id", authority: "operator" },
  { method: "POST", path: "/runs/:run_id/cancel", authority: "operator" },
  { method: "DELETE", path: "/runs/:run_id", authority: "operator" },
  { method: "POST", path: "/runs/:run_id/scopes/:scope_id/decide", authority: "operator", raw_ingress: true },
  { method: "GET", path: "/api/inbox", authority: "operator" },
  { method: "GET", path: "/api/session_holds/:sid", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/definition", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/scopes/:scope_id", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/scopes/:scope_id/decision", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/scopes/:scope_id/history", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/scopes/:scope_id/diagnostics", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/scopes/:scope_id/commands", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/scopes/:scope_id/publications", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/scopes/:scope_id/executions/:execution_id/contract", authority: "execution" },
  { method: "PUT", path: "/api/runs/:run_id/scopes/:scope_id/executions/:execution_id/outputs/:output_key", authority: "execution" },
  { method: "POST", path: "/api/runs/:run_id/scopes/:scope_id/executions/:execution_id/facts/:fact_key", authority: "execution" },
];

export function activeRoutes(is_raw_ingress_enabled: boolean): readonly HttpRoute[] {
  return HTTP_ROUTES.filter((route) => !route.raw_ingress || is_raw_ingress_enabled);
}

export function matchRoute(method: string, path: string, routes: readonly HttpRoute[] = HTTP_ROUTES): HttpRoute | undefined {
  const segments = path.split("/");
  return routes.find((route) => {
    if (route.method !== method && !(method === "HEAD" && route.method === "GET")) return false;
    const pattern = route.path.split("/");
    return pattern.length === segments.length && pattern.every((part, index) => part.startsWith(":") || part === segments[index]);
  });
}
