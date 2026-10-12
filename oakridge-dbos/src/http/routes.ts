/** The process HTTP contract. The proxy imports this only from its server code. */
export type RouteAuthority = "open" | "operator" | "execution";
export interface HttpRoute {
  readonly method: "GET" | "POST" | "PUT" | "DELETE";
  readonly path: string;
  readonly authority: RouteAuthority;
}

export const HTTP_ROUTES: readonly HttpRoute[] = [
  { method: "GET", path: "/health", authority: "open" },
  { method: "GET", path: "/events", authority: "operator" },
  { method: "POST", path: "/api/runs", authority: "operator" },
  { method: "GET", path: "/api/runs", authority: "operator" },
  { method: "GET", path: "/api/definitions", authority: "operator" },
  { method: "GET", path: "/api/definitions/:bundle_id", authority: "operator" },
  { method: "POST", path: "/api/definitions/compile", authority: "operator" },
  { method: "GET", path: "/api/prompts", authority: "operator" },
  { method: "POST", path: "/api/definitions", authority: "operator" },
  { method: "POST", path: "/api/definitions/:bundle_id/archive", authority: "operator" },
  { method: "POST", path: "/api/definitions/:bundle_id/unarchive", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/archive", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/unarchive", authority: "operator" },
  { method: "GET", path: "/api/projects", authority: "operator" },
  { method: "POST", path: "/api/projects", authority: "operator" },
  { method: "PUT", path: "/api/projects/:project_id", authority: "operator" },
  { method: "DELETE", path: "/runs/:run_id", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/cancel", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/units/:unit_id/workers/:worker/retry", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/inspect", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/definition", authority: "operator" },
  { method: "GET", path: "/api/runs/:run_id/scopes/:scope_id/revisions/:revision_id/threads", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/scopes/:scope_id/revisions/:revision_id/threads", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/scopes/:scope_id/threads/:thread_id/messages", authority: "operator" },
  { method: "POST", path: "/api/runs/:run_id/scopes/:scope_id/threads/:thread_id/review-items", authority: "operator" },
];

export function matchRoute(method: string, path: string, routes: readonly HttpRoute[] = HTTP_ROUTES): HttpRoute | undefined {
  const segments = path.split("/");
  return routes.find((route) => {
    if (route.method !== method && !(method === "HEAD" && route.method === "GET")) return false;
    const pattern = route.path.split("/");
    return pattern.length === segments.length && pattern.every((part, index) => part.startsWith(":") || part === segments[index]);
  });
}
