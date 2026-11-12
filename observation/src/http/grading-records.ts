import { stagesFromReadiness, type RollupContext } from "../grading/task-stages";
import { filterCompositeStage, selectComposite, selectCompositePage, selectDrilldown, selectRunStages } from "../grading/composite";
import { hasCapturedRun, readValidatedRun, selectGradeableItems } from "../storage/grading-record-store";
import type { Hono } from "hono";
import { z } from "zod";
import { COMPOSITE_WINDOWS, EVIDENCE_WINDOWS, compositeRead, drilldownRowRead } from "../grading/item-reads";
import type { CompositeDrilldownKey } from "../grading/composite";
import { listRunUnlinkedAddressed, listRunUnresolvedAddressed, readEvidenceSet,
  readLogicalItemLineage, readQuestionRecord } from "../storage/grading-record-store";
import { readRunSpend } from "../storage/execution-store";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";
import { listWindows, pagination } from "./items";
import type { SourceDependencies } from "./sources";

const INVALID = "limit must be 1..200 and offset nonnegative, for the list and for each nested list";
/**
 * A key is echoed from a composite this service served; its rows are still read inside the requested
 * run. Every selector variant is checked in full, so a malformed key is refused here and never reaches
 * the read. The final cast only adds the id brands, which have no runtime form.
 */
const text = z.string().min(1);
const questionKeySchema = z.strictObject({ question_id: text, question_version: text });
const graderKeySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("machine"), evaluator_definition_id: text, backend_kind: z.string(), model: z.string().nullable() }),
  z.strictObject({ kind: z.literal("human"), evaluator_definition_id: text, reviewer_id: text })]);
const answerKeySchema = z.union([z.strictObject({ state: z.literal("answered"), value: z.json() }), z.strictObject({ state: z.enum(["abstain", "unclear"]) })]);
const statusKeySchema = z.union([
  z.strictObject({ state: z.literal("not_ready"), code: text }),
  z.strictObject({ state: z.enum(["grading_off", "awaiting_admission", "pending", "budget_deferred"]) }),
  z.strictObject({ state: z.literal("failed"), terminal_cause: z.enum(["retry_exhausted", "runner_failed", "invalid_outcome"]).nullable() })]);
const selectorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("items") }),
  z.strictObject({ kind: z.literal("history") }),
  z.strictObject({ kind: z.literal("answer"), question: questionKeySchema, grader: graderKeySchema, answer: answerKeySchema }),
  z.strictObject({ kind: z.literal("status"), question: questionKeySchema, evaluator_definition_id: text.nullable(), status: statusKeySchema }),
  z.strictObject({ kind: z.literal("disagreement"), question: questionKeySchema })]);
const drilldownKeySchema = z.strictObject({ logical_item_id: text, stage: text, selector: selectorSchema });
export const parseDrilldownKey = (raw: string | undefined): CompositeDrilldownKey | null => {
  try {
    const parsed = drilldownKeySchema.safeParse(JSON.parse(raw ?? ""));
    return parsed.success ? parsed.data as CompositeDrilldownKey : null;
  } catch { return null; }
};

export function registerGradingRecordRoutes(app: Hono, deps: SourceDependencies): void {
  const path = deps.profile.composite;
  const contextFor = async (run_id: string) => {
    const read = deps.stage_source ? await deps.stage_source.read(run_id) : { ok: true as const, value: [] };
    if (!read.ok) return read;
    const context: RollupContext = { stages: stagesFromReadiness(read.value), pins: deps.capture_configuration?.pins ?? [] };
    return { ok: true as const, value: context };
  };
  app.get("/v1/runs/:run_id/grading-stages", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    if (!await hasCapturedRun(deps.db, tenant, c.req.param("run_id")))
      return errorResponse(c, 404, "not_found", "this tenant has captured no such run");
    const context = await contextFor(c.req.param("run_id"));
    if (!context.ok) return errorResponse(c, 502, "stage_read_failed", context.error.detail);
    const result = await readValidatedRun(deps.db, tenant, path, { run_id: c.req.param("run_id"), context: context.value, stage: null }, selectRunStages);
    return result.ok ? c.json(result.value) : errorResponse(c, 400, "invalid_stage", result.error.stage);
  });
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
  /** One frozen evidence set as the named paged evidence read; references and pinned evaluators each page through their own window. */
  app.get("/v1/evidence-sets/:id", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const windows = listWindows(c.req.url, EVIDENCE_WINDOWS);
    if (!windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const evidence = await readEvidenceSet(deps.db, tenant, c.req.param("id"), windows);
    return evidence ? c.json(evidence) : errorResponse(c, 404, "not_found", "evidence set not found");
  });
  /** Every gradeable item of one stage, or of every stage. Links are explicit; an item with none is listed like any other. */
  app.get("/v1/runs/:run_id/gradeable-items", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    const windows = listWindows(c.req.url, ["links"]);
    if (!page || !windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const stage = c.req.query("stage") ?? null;
    const context = await contextFor(c.req.param("run_id"));
    if (!context.ok) return errorResponse(c, 502, "stage_read_failed", context.error.detail);
    const result = await readValidatedRun(deps.db, tenant, path, { run_id: c.req.param("run_id"), context: context.value, stage },
      (inputs) => selectGradeableItems(inputs, path, { stage, is_current_only: c.req.query("revisions") !== "all", page, links: windows.links }));
    return result.ok ? c.json(result.value) : errorResponse(c, 400, "invalid_stage", "unknown run stage");
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
    const context = await contextFor(c.req.param("run_id"));
    if (!context.ok) return errorResponse(c, 502, "stage_read_failed", context.error.detail);
    const stage = c.req.query("stage") ?? null;
    const result = await readValidatedRun(deps.db, tenant, path, { run_id: c.req.param("run_id"), context: context.value, stage },
      (inputs) => selectCompositePage({ inputs, path, page }));
    if (!result.ok) return errorResponse(c, 400, "invalid_stage", "unknown run stage");
    return c.json({ ...result.value, items: result.value.items.map((composite) => compositeRead(filterCompositeStage(composite, stage), windows)) });
  });
  /** Explicit navigation to one logical item, inside the run. An unknown id is a 404 here and stays visible on the items that named it. */
  app.get("/v1/runs/:run_id/logical-items/:local_id", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const windows = listWindows(c.req.url, COMPOSITE_WINDOWS);
    if (!windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const context = await contextFor(c.req.param("run_id"));
    if (!context.ok) return errorResponse(c, 502, "stage_read_failed", context.error.detail);
    const stage = c.req.query("stage") ?? null;
    const result = await readValidatedRun(deps.db, tenant, path, { run_id: c.req.param("run_id"), context: context.value, stage }, (inputs) => {
      const item = inputs.logical_items.find((candidate) => candidate.producer_local_id === c.req.param("local_id"));
      return item ? selectComposite(inputs, path, item) : null;
    });
    if (!result.ok) return errorResponse(c, 400, "invalid_stage", "unknown run stage");
    return result.value ? c.json(compositeRead(filterCompositeStage(result.value, stage), windows)) : errorResponse(c, 404, "not_found", "this run has captured no such logical item");
  });
  app.get("/v1/runs/:run_id/logical-items/:local_id/lineage", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const context = await contextFor(c.req.param("run_id"));
    if (!context.ok) return errorResponse(c, 502, "stage_read_failed", context.error.detail);
    return c.json(await readLogicalItemLineage(deps.db, tenant, path, c.req.param("run_id"), c.req.param("local_id"), page, context.value));
  });
  /** The exact items, raw answers and frozen evidence behind one count of a composite. */
  app.get("/v1/runs/:run_id/composite-drilldown", async (c) => {
    const tenant = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "read credential required");
    const key = parseDrilldownKey(c.req.query("key"));
    if (!key) return errorResponse(c, 400, "invalid_drilldown", "key must be a drilldown key a composite served");
    const rows = pagination(c.req.url);
    const windows = listWindows(c.req.url, ["questions", "links", "statuses", "answers", "superseded_answers", "results", ...EVIDENCE_WINDOWS]);
    if (!rows || !windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const context = await contextFor(c.req.param("run_id"));
    if (!context.ok) return errorResponse(c, 502, "stage_read_failed", context.error.detail);
    const result = await readValidatedRun(deps.db, tenant, path, { run_id: c.req.param("run_id"), context: context.value, stage: key.stage },
      (inputs) => selectDrilldown(inputs, path, key, { ...windows, rows }));
    return result.ok ? c.json({ ...result.value, items: result.value.items.map((row) => drilldownRowRead(row, windows)) })
      : errorResponse(c, 400, "invalid_stage", "unknown run stage");
  });
}
