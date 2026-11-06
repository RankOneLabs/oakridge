import type { Hono } from "hono";
import { listGrades } from "../storage/grading-store";
import type { SourceDependencies } from "./sources";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";

export function registerGradeRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/items/:id/grades", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const params = new URL(c.req.url).searchParams;
    const limit = Number(params.get("limit") ?? "50"); const offset = Number(params.get("offset") ?? "0");
    if (!Number.isInteger(limit) || limit < 1 || limit > 200 || !Number.isSafeInteger(offset) || offset < 0)
      return errorResponse(c, 400, "invalid_pagination", "limit must be 1..200 and offset nonnegative");
    const page = await listGrades(deps.db, credential, c.req.param("id"), { limit, offset });
    return page ? c.json(page) : errorResponse(c, 404, "not_found", "item not found");
  });
}
