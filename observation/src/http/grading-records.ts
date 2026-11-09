import type { Hono } from "hono";
import { z } from "zod";
import { COMPOSITE_WINDOWS, EVIDENCE_WINDOWS, compositeRead, drilldownRowRead } from "../grading/item-reads";
import type { CompositeDrilldownKey } from "../grading/composite";
import { listRunComposites, listRunGradeableItems, listRunUnlinkedAddressed, listRunUnresolvedAddressed, readCompositeDrilldown, readEvidenceSetRecord, readLogicalItemComposite,
  readLogicalItemLineage, readQuestionRecord } from "../storage/grading-record-store";
import { readRunSpend } from "../storage/execution-store";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";
import { listWindows, pagination } from "./items";
import type { SourceDependencies } from "./sources";

const INVALID = "limit must be 1..200 and offset nonnegative, for the list and for each nested list";
/** A key is echoed from a composite this service served; its rows are still read inside the requested run. */
const drilldownKeySchema = z.object({ logical_item_id: z.string().min(1), stage: z.string().min(1),
  selector: z.looseObject({ kind: z.enum(["items", "history", "answer", "status", "disagreement"]) }) });
const parseDrilldownKey = (raw: string | undefined): CompositeDrilldownKey | null => {
  try {
    const parsed = drilldownKeySchema.safeParse(JSON.parse(raw ?? ""));
    return parsed.success ? parsed.data as unknown as CompositeDrilldownKey : null;
  } catch { return null; }
};

export function registerGradingRecordRoutes(app: Hono, deps: SourceDependencies): void {
  const path = deps.profile.composite;
  app.get("/v1/questions/:id/versions/:version", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const record = await readQuestionRecord(deps.db, tenant, {
      question_id: c.req.param("id"), question_version: c.req.param("version"),
    });
    return record ? c.json(record) : errorResponse(c, 404, "not_found", "question version not found");
  });
  /** A run's grading state: its committed choice, spend in configured estimates, request count and execution statuses. */
  app.get("/v1/runs/:run_id/grading-spend", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    return c.json(await readRunSpend(deps.db, tenant, c.req.param("run_id")));
  });
  app.get("/v1/evidence-sets/:id", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const record = await readEvidenceSetRecord(deps.db, tenant, c.req.param("id"));
    return record ? c.json(record) : errorResponse(c, 404, "not_found", "evidence set not found");
  });
  /** Every gradeable item of one stage, or of every stage. Links are explicit; an item with none is listed like any other. */
  app.get("/v1/runs/:run_id/gradeable-items", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    const windows = listWindows(c.req.url, ["links"]);
    if (!page || !windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const stage = c.req.query("stage") ?? null;
    if (stage !== null && !path.stages.some((candidate) => candidate.stage === stage)) return errorResponse(c, 400, "invalid_stage", "stage is not one this producer has");
    return c.json(await listRunGradeableItems(deps.db, tenant, path, c.req.param("run_id"), { stage, is_current_only: c.req.query("revisions") !== "all", page, links: windows.links }));
  });
  /** Items linked to nothing, as gradeable and inspectable as any other. */
  app.get("/v1/runs/:run_id/unlinked-items", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", INVALID);
    return c.json(await listRunUnlinkedAddressed(deps.db, tenant, path, c.req.param("run_id"), page));
  });
  /** References to logical items the run has not captured, each with the item that made it. Never matched to anything. */
  app.get("/v1/runs/:run_id/unresolved-references", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", INVALID);
    return c.json(await listRunUnresolvedAddressed(deps.db, tenant, path, c.req.param("run_id"), page));
  });
  app.get("/v1/runs/:run_id/logical-items", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    const windows = listWindows(c.req.url, COMPOSITE_WINDOWS);
    if (!page || !windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const composites = await listRunComposites(deps.db, tenant, path, c.req.param("run_id"), page);
    return c.json({ ...composites, items: composites.items.map((composite) => compositeRead(composite, windows)) });
  });
  /** Explicit navigation to one logical item, inside the run. An unknown id is a 404 here and stays visible on the items that named it. */
  app.get("/v1/runs/:run_id/logical-items/:local_id", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const windows = listWindows(c.req.url, COMPOSITE_WINDOWS);
    if (!windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const composite = await readLogicalItemComposite(deps.db, tenant, path, c.req.param("run_id"), c.req.param("local_id"));
    return composite ? c.json(compositeRead(composite, windows)) : errorResponse(c, 404, "not_found", "this run has captured no such logical item");
  });
  app.get("/v1/runs/:run_id/logical-items/:local_id/lineage", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", INVALID);
    return c.json(await readLogicalItemLineage(deps.db, tenant, path, c.req.param("run_id"), c.req.param("local_id"), page));
  });
  /** The exact items, raw answers and frozen evidence behind one count of a composite. */
  app.get("/v1/runs/:run_id/composite-drilldown", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const key = parseDrilldownKey(c.req.query("key"));
    if (!key) return errorResponse(c, 400, "invalid_drilldown", "key must be a drilldown key a composite served");
    const rows = pagination(c.req.url);
    const windows = listWindows(c.req.url, ["questions", "links", "statuses", "answers", "superseded_answers", ...EVIDENCE_WINDOWS]);
    if (!rows || !windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const page = await readCompositeDrilldown(deps.db, tenant, path, c.req.param("run_id"), key, { ...windows, rows });
    return c.json({ ...page, items: page.items.map((row) => drilldownRowRead(row, windows)) });
  });
}
