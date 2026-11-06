import type { Hono } from "hono";
import { listGrades } from "../storage/grading-store";
import type { SourceDependencies } from "./sources";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";
import { pagination } from "./items";

export function registerGradeRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/items/:id/grades", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", "limit must be 1..200 and offset nonnegative");
    const grades = await listGrades(deps.db, credential, c.req.param("id"), page);
    return grades ? c.json(grades) : errorResponse(c, 404, "not_found", "item not found");
  });
}
