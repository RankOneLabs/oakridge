import type { Hono } from "hono";
import { z } from "zod";

/**
 * The observation service as kbbl's server holds it. The tokens stay here: they
 * are never returned to a browser, and ACP agents inherit no `OAKRIDGE_*`
 * variable. Operator authentication is kbbl's own control policy, not these.
 */
export interface ObservationServerConfig {
  url: string;
  namespace: string;
  readToken: string | null;
  gradeToken: string | null;
  configureToken: string | null;
}

export function observationServerConfigFromEnv(env: Readonly<Record<string, string | undefined>>): ObservationServerConfig | null {
  const url = env.OAKRIDGE_OBSERVATION_URL?.trim();
  if (!url) return null;
  return {
    url,
    namespace: env.OAKRIDGE_OBSERVATION_NAMESPACE?.trim() || "default",
    readToken: env.OAKRIDGE_OBSERVATION_READ_TOKEN?.trim() || null,
    gradeToken: env.OAKRIDGE_OBSERVATION_GRADE_TOKEN?.trim() || null,
    configureToken: env.OAKRIDGE_OBSERVATION_CONFIGURE_TOKEN?.trim() || null,
  };
}

export type ObservationDownReason = "unreachable" | "timeout" | "http_error" | "invalid_response" | "database_unavailable";
export interface ConfiguredGrader { runner: string; evaluatorDefinitionId: string }
/**
 * Availability and capability as the service itself reports them. A URL, a token
 * or an open port proves none of this, and a `down` observation says nothing
 * about DBOS: workflow authority does not depend on it.
 */
export type ObservationHealth =
  | { state: "not_configured" }
  | { state: "down"; reason: ObservationDownReason }
  | { state: "no_configured_graders" }
  | { state: "configured"; graders: ConfiguredGrader[] };

const serviceHealth = z.object({
  service: z.literal("observation"),
  database: z.enum(["available", "unavailable"]),
  graders: z.discriminatedUnion("state", [
    z.object({ state: z.literal("none_configured") }),
    z.object({ state: z.literal("configured"), graders: z.array(z.object({
      runner: z.string().min(1), evaluator_definition_id: z.string().min(1) })).min(1) }),
  ]),
});

/** The service's own reading of itself, once it has answered. */
function fromServiceBody(body: unknown): ObservationHealth {
  const parsed = serviceHealth.safeParse(body);
  if (!parsed.success) return { state: "down", reason: "invalid_response" };
  if (parsed.data.database === "unavailable") return { state: "down", reason: "database_unavailable" };
  if (parsed.data.graders.state === "none_configured") return { state: "no_configured_graders" };
  return { state: "configured", graders: parsed.data.graders.graders.map((grader) => ({
    runner: grader.runner, evaluatorDefinitionId: grader.evaluator_definition_id })) };
}

async function requestHealth(url: string, fetcher: typeof fetch, signal: AbortSignal): Promise<ObservationHealth> {
  const response = await fetcher(new URL("/health", url), { signal });
  // 503 is the service answering that its database is gone; its body says so.
  if (!response.ok && response.status !== 503) return { state: "down", reason: "http_error" };
  return fromServiceBody(await response.json().catch(() => null));
}

export const OBSERVATION_HEALTH_TIMEOUT_MS = 2_000;

export interface ObservationHealthCheck {
  config: ObservationServerConfig | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

/** Bounded end to end, body included: a hung service reads as down and never holds kbbl's response. */
export async function checkObservationHealth(check: ObservationHealthCheck): Promise<ObservationHealth> {
  if (!check.config) return { state: "not_configured" };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<ObservationHealth>((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve({ state: "down", reason: "timeout" }); },
      check.timeoutMs ?? OBSERVATION_HEALTH_TIMEOUT_MS);
  });
  const answered = requestHealth(check.config.url, check.fetcher ?? fetch, controller.signal)
    .catch((): ObservationHealth => ({ state: "down", reason: "unreachable" }));
  try { return await Promise.race([answered, expired]); }
  finally { clearTimeout(timer); }
}

export interface KbblHealth {
  status: "ok";
  observation: ObservationHealth;
  /** Whether this server holds each capability, never its value. */
  capabilities: { read: boolean; grade: boolean; configure: boolean };
}

export function mountHealthRoutes(app: Hono, check: ObservationHealthCheck): void {
  app.get("/health", async (c) => c.json({
    status: "ok",
    observation: await checkObservationHealth(check),
    capabilities: { read: Boolean(check.config?.readToken), grade: Boolean(check.config?.gradeToken), configure: Boolean(check.config?.configureToken) },
  } satisfies KbblHealth));
}
