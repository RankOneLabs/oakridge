import type { Hono } from "hono";
import { sql } from "kysely";
import type { Database } from "../storage/database";

export interface ConfiguredGrader { readonly runner: string; readonly evaluator_definition_id: string }
/** What the running service has actually registered; a URL, token or old grade row is not capability. */
export type GraderCapability =
  | { readonly state: "none_configured" }
  | { readonly state: "configured"; readonly graders: readonly ConfiguredGrader[] };
export type DatabaseHealth = "available" | "unavailable";
export interface ObservationHealth {
  readonly service: "observation";
  readonly status: "ok" | "degraded";
  readonly database: DatabaseHealth;
  readonly graders: GraderCapability;
}
export interface HealthDependencies {
  readonly db: Database;
  /** Absent means nothing is registered. */
  readonly grader_capability?: () => GraderCapability;
  readonly database_check_ms?: number;
}

export const NO_CONFIGURED_GRADERS: GraderCapability = { state: "none_configured" };
const DATABASE_CHECK_MS = 1_000;

/** A pool waiting on a dead server must not hold the health response open. */
async function checkDatabase(db: Database, timeout_ms: number): Promise<DatabaseHealth> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<DatabaseHealth>((resolve) => { timer = setTimeout(() => resolve("unavailable"), timeout_ms); });
  const reached = sql`SELECT 1`.execute(db).then((): DatabaseHealth => "available", (): DatabaseHealth => "unavailable");
  try { return await Promise.race([reached, expired]); }
  finally { clearTimeout(timer); }
}

export async function readObservationHealth(deps: HealthDependencies): Promise<ObservationHealth> {
  const database = await checkDatabase(deps.db, deps.database_check_ms ?? DATABASE_CHECK_MS);
  return { service: "observation", status: database === "available" ? "ok" : "degraded", database,
    graders: deps.grader_capability?.() ?? NO_CONFIGURED_GRADERS };
}

/** Open like the DBOS health route: it carries availability and registered capability, never a credential. */
export function registerHealthRoute(app: Hono, deps: HealthDependencies): void {
  app.get("/health", async (c) => {
    const health = await readObservationHealth(deps);
    return c.json(health, health.status === "ok" ? 200 : 503);
  });
}
