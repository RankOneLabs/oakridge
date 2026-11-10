import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { browserJsonWriteRejection, browserWritePolicy, configuredBrowserWritePolicy } from "../../../../oakridge-dbos/src/http/browser-write-policy";
import { isValidControlRequest } from "../../../../oakridge-dbos/src/http/control-auth";
import type { ObservationServerConfig } from "./observation-health";

export interface ObservationProxyDeps {
  observation: ObservationServerConfig | null;
  /** kbbl's own control token. Undefined leaves the inbound check to kbbl's policy, exactly as the Oakridge proxy does. */
  browserControlToken?: string;
  /** Explicit browser origins; an absent list uses the configured policy. */
  allowedOrigins?: readonly string[];
}

const OBSERVATION_FORWARD_TIMEOUT_MS = 30_000;
type Capability = "read" | "grade";
const capabilityToken = (config: ObservationServerConfig, capability: Capability): string | null =>
  capability === "read" ? config.readToken : config.gradeToken;

/** The whole of what a browser may submit. Anything else, a reviewer or evaluator included, is not forwarded. */
const SUBMISSION_FIELDS = ["question_id", "question_version", "submission_id", "answer", "rationale", "corrects_observation_id"] as const;
function submissionBody(input: unknown): string | null {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return null;
  const fields = input as Readonly<Record<string, unknown>>;
  return JSON.stringify(Object.fromEntries(SUBMISSION_FIELDS.flatMap((field) => field in fields ? [[field, fields[field]]] : [])));
}

const refusal = (c: Context, status: 400 | 401 | 502 | 503, code: string, message: string): Response => c.json({ error: { code, message } }, status);
const segment = (value: string | undefined): string => encodeURIComponent(value ?? "");

/**
 * The one way a browser reaches observation. Every route is listed here and names the capability it
 * uses, so nothing else on the service is reachable. The operator is authenticated first, by kbbl's
 * own control policy; the matching server-held token then replaces every browser credential, and
 * observation binds the reviewer to that token. No token, provider key or browser header crosses.
 */
export function mountObservationProxyRoutes(app: Hono, deps: ObservationProxyDeps): void {
  const write_policy = deps.allowedOrigins === undefined ? configuredBrowserWritePolicy() : browserWritePolicy(deps.allowedOrigins);
  const forward = async (c: Context, capability: Capability, upstream_path: string, body?: string): Promise<Response> => {
    if (deps.browserControlToken && !isValidControlRequest(c.req.raw, deps.browserControlToken, write_policy))
      return refusal(c, 401, "unauthorized", "control credential required");
    if (!deps.observation) return refusal(c, 503, "observation_not_configured", "observation is not part of this deployment");
    const token = capabilityToken(deps.observation, capability);
    if (!token) return refusal(c, 503, "observation_capability_missing", `this server holds no observation ${capability} capability`);
    const search = new URL(c.req.url, "http://localhost").search;
    try {
      const response = await fetch(deps.observation.url.replace(/\/$/, "") + upstream_path + search, { method: c.req.method, body,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        signal: AbortSignal.timeout(OBSERVATION_FORWARD_TIMEOUT_MS) });
      return new Response(await response.text(), { status: response.status, headers: {
        "content-type": response.headers.get("content-type") ?? "application/json", "cache-control": "no-store" } });
    } catch (cause) {
      return refusal(c, 502, "observation_unreachable", `observation did not answer: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  };
  const read = (route: string, upstream: (c: Context) => string): void => { app.get(`/oakridge/observation${route}`, (c) => forward(c, "read", upstream(c))); };
  const run = (c: Context) => `/v1/runs/${segment(c.req.param("run_id"))}`;
  const task = (c: Context) => `${run(c)}/logical-items/${segment(c.req.param("task_id"))}`;
  const item = (c: Context) => `/v1/items/${segment(c.req.param("id"))}`;

  app.use("/oakridge/observation/*", bodyLimit({ maxSize: 1_048_576, onError: (c) => c.json({ error: { code: "oversized_payload", message: "body too large" } }, 413) }));
  read("/runs/:run_id/grading", (c) => `${run(c)}/grading-spend`);
  read("/runs/:run_id/items/at", (c) => `${run(c)}/items/at`);
  read("/runs/:run_id/findings", (c) => `${run(c)}/gradeable-items`);
  read("/runs/:run_id/unlinked-findings", (c) => `${run(c)}/unlinked-items`);
  read("/runs/:run_id/unresolved-task-references", (c) => `${run(c)}/unresolved-references`);
  read("/runs/:run_id/tasks", (c) => `${run(c)}/logical-items`);
  read("/runs/:run_id/tasks/:task_id", task);
  read("/runs/:run_id/tasks/:task_id/lineage", (c) => `${task(c)}/lineage`);
  read("/runs/:run_id/drilldown", (c) => `${run(c)}/composite-drilldown`);
  read("/items/:id/status", (c) => `${item(c)}/status`);
  read("/items/:id/answers", (c) => `${item(c)}/answers`);
  read("/items/:id/lineage", (c) => `${item(c)}/lineage`);
  /** Names this server's reviewer, so the panel can tell the operator's own answer apart. */
  app.get("/oakridge/observation/reviewer", (c) => forward(c, "grade", "/v1/reviewer"));
  app.post("/oakridge/observation/items/:id/answers", async (c) => {
    const rejection = browserJsonWriteRejection(write_policy, c.req.raw);
    if (rejection) return rejection;
    const body = submissionBody(await c.req.json().catch(() => null));
    if (body === null) return refusal(c, 400, "invalid_json", "a JSON object is required");
    return forward(c, "grade", `${item(c)}/answers`, body);
  });
}
