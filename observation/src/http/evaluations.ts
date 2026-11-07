import type { Hono } from "hono";
import { withTenant } from "../storage/database";
import { readExecution } from "../storage/grading-store";
import type { SourceDependencies } from "./sources";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";

/** Executions are read here and written only by the target lifecycle; no route dispatches one. */
export function registerEvaluationRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/evaluations/by-digest/:digest", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const execution = await withTenant(deps.db, credential, (trx) => trx.selectFrom("observation.evaluation_execution")
      .selectAll().where("producer", "=", credential.producer).where("namespace", "=", credential.namespace)
      .where("idempotency_digest", "=", c.req.param("digest")).executeTakeFirst());
    if (!execution) return errorResponse(c, 404, "not_found", "evaluation not found");
    const observation = await withTenant(deps.db, credential, (trx) => trx.selectFrom("observation.grade_observation")
      .selectAll().where("producer", "=", credential.producer).where("namespace", "=", credential.namespace)
      .where("execution_id", "=", execution.execution_id).executeTakeFirst());
    return c.json({ execution, observation: observation ?? null });
  });
  app.get("/v1/evaluation-executions/:id", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), [...deps.credentials.read, ...(deps.credentials.grade ?? [])]);
    if (!credential) return errorResponse(c, 403, "forbidden", "read or grade credential required");
    const execution = await readExecution(deps.db, credential, c.req.param("id"));
    return execution ? c.json(execution) : errorResponse(c, 404, "not_found", "execution not found");
  });
}
