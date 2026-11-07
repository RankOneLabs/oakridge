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

export type DatabaseProbe = () => Promise<DatabaseHealth>;

/**
 * One probe in flight at a time, bounded on both sides: the response stops
 * waiting at the deadline, and PostgreSQL ends the statement there itself. A
 * request that arrives while a probe is pending waits on that probe, so a
 * server that stopped answering holds at most one connection for health.
 */
export function databaseProbe(db: Database, timeout_ms: number): DatabaseProbe {
  let in_flight: Promise<DatabaseHealth> | null = null;
  const query = (): Promise<DatabaseHealth> => Promise.resolve()
    .then(() => db.transaction().execute(async (trx) => {
      await sql`SELECT set_config('statement_timeout', ${String(timeout_ms)}, true)`.execute(trx);
      await sql`SELECT 1`.execute(trx);
    }))
    .then((): DatabaseHealth => "available", (): DatabaseHealth => "unavailable");
  return async () => {
    const probe = in_flight ??= query().finally(() => { in_flight = null; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<DatabaseHealth>((resolve) => { timer = setTimeout(() => resolve("unavailable"), timeout_ms); });
    try { return await Promise.race([probe, expired]); }
    finally { clearTimeout(timer); }
  };
}

export async function readObservationHealth(probe: DatabaseProbe, grader_capability: HealthDependencies["grader_capability"]): Promise<ObservationHealth> {
  const database = await probe();
  return { service: "observation", status: database === "available" ? "ok" : "degraded", database,
    graders: grader_capability?.() ?? NO_CONFIGURED_GRADERS };
}

/** Open like the DBOS health route: it carries availability and registered capability, never a credential. */
export function registerHealthRoute(app: Hono, deps: HealthDependencies): void {
  const probe = databaseProbe(deps.db, deps.database_check_ms ?? DATABASE_CHECK_MS);
  app.get("/health", async (c) => {
    const health = await readObservationHealth(probe, deps.grader_capability);
    return c.json(health, health.status === "ok" ? 200 : 503);
  });
}
