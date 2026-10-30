import type { Hono } from "hono";
import { listRunItems, readItem, readLineage, type Page } from "../storage/projection-store";
import type { SourceDependencies } from "./sources";
import { errorResponse } from "./errors";
import { credentialFor } from "./ingest-auth";
import { readCoverage } from "../storage/coverage-store";

function pagination(url: string): Page | null {
  const params = new URL(url).searchParams;
  const limit = Number(params.get("limit") ?? "50");
  const offset = Number(params.get("offset") ?? "0");
  return Number.isInteger(limit) && limit >= 1 && limit <= 200 && Number.isSafeInteger(offset) && offset >= 0
    ? { limit, offset } : null;
}

export function registerItemRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/runs/:run_id/coverage", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const params = new URL(c.req.url).searchParams;
    const question_id = params.get("question_id"); const question_version = params.get("question_version");
    if (Boolean(question_id) !== Boolean(question_version))
      return errorResponse(c, 400, "invalid_selection", "question id and version must be supplied together");
    return c.json(await readCoverage(deps.db, credential, { run_id: c.req.param("run_id"),
      revision_id: params.get("revision_id"), question_id, question_version }));
  });
  app.get("/v1/runs/:run_id/items", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", "limit must be 1..200 and offset nonnegative");
    return c.json(await listRunItems(deps.db, credential, c.req.param("run_id"), page));
  });
  app.get("/v1/items/:id/lineage", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", "limit must be 1..200 and offset nonnegative");
    const lineage = await readLineage(deps.db, credential, c.req.param("id"), page);
    return lineage ? c.json(lineage) : errorResponse(c, 404, "not_found", "item not found");
  });
  app.get("/v1/items/:id", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const item = await readItem(deps.db, credential, c.req.param("id"));
    return item ? c.json(item) : errorResponse(c, 404, "not_found", "item not found");
  });
}
