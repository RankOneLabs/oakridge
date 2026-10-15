import type { Context, Hono } from "hono";
import type { UnitId } from "../domain/primitives";
import { selectArtifactDetail } from "../projections/artifact-view";
import { selectDefinitionDetail, selectDefinitionSummary, selectPinnedDefinition } from "../projections/definition-view";
import { selectUnitDiagnostics, selectUnitHistory } from "../projections/history-view";
import { selectInboxPage, selectRunInboxBatch, selectRunInboxItems } from "../projections/inbox";
import { selectRunInspect, selectRunUnitView, selectRunView } from "../projections/run-view";
import type { Database } from "../storage/database";
import type { SessionHoldResponse } from "../projections/session-hold";
import { listDefinitions, listLiveRuns, listRuns, readDefinition, readHistory, readPinnedDefinition, readRun, readRunInspect, readSessionHold,
  readRunSummaries, readRunSummary, readUnitDiagnostics, type HistoryCursor } from "../storage/read-store";
import { errorResponse, fault, MalformedRequestError, MissingEntityError } from "./errors";

/**
 * The operator read models: each route reads authority rows
 * from the read store and answers with its projection.
 */
export interface ReadModelDependencies { readonly db: Database }

const DEFAULT_PAGE_LIMIT = 100;
export function pageLimit(raw: string | undefined): number | MalformedRequestError {
  const limit = raw === undefined ? DEFAULT_PAGE_LIMIT : Number(raw);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= DEFAULT_PAGE_LIMIT ? limit : new MalformedRequestError("invalid page limit");
}
const encodeCursor = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function decodeCursor<Value>(raw: string | undefined, accept: (value: unknown) => value is Value, what: string): Value | null | MalformedRequestError {
  if (raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    return accept(value) ? value : new MalformedRequestError(`invalid ${what} cursor`);
  } catch { return new MalformedRequestError(`invalid ${what} cursor`); }
}
const isObject = (value: unknown): value is { readonly [key: string]: unknown } => !!value && typeof value === "object" && !Array.isArray(value);
const isTimeCursor = (value: unknown): value is { readonly created_at: string; readonly id: string } => isObject(value)
  && typeof value.created_at === "string" && Number.isFinite(Date.parse(value.created_at)) && typeof value.id === "string" && value.id !== "";
const isIdCursor = (value: unknown): value is string => typeof value === "string" && value !== "";
/** `?archived=true` lists archived items; without it, the active ones. */
function archivedQuery(raw: string | undefined): boolean | MalformedRequestError {
  if (raw === undefined || raw === "false") return false;
  return raw === "true" ? true : new MalformedRequestError("archived must be true or false");
}
const definitionCursor = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value);

/** A read that answers 404 when its subject is missing. */
const found = <Value>(context: Context, value: Value | null, what: string): Response =>
  value === null ? errorResponse(new MissingEntityError(`${what} not found`)) : context.json(value);

export function installReadModels(app: Hono, deps: ReadModelDependencies): void {
  const { db } = deps;

  app.get("/api/runs", async (c) => { try {
    const limit = pageLimit(c.req.query("limit"));
    if (limit instanceof MalformedRequestError) return errorResponse(limit);
    const after = decodeCursor(c.req.query("cursor"), isTimeCursor, "runs");
    if (after instanceof MalformedRequestError) return errorResponse(after);
    const is_archived = archivedQuery(c.req.query("archived"));
    if (is_archived instanceof MalformedRequestError) return errorResponse(is_archived);
    const page = await listRuns(db, { after, limit, is_archived });
    return c.json({ items: page.items.map(selectRunView),
      next_cursor: page.next ? encodeCursor(page.next) : null });
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id", async (c) => { try {
    const read = await readRun(db, c.req.param("run_id"));
    return found(c, read && selectRunView(read), "run");
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id/inspect", async (c) => { try {
    const read = await readRunInspect(db, c.req.param("run_id"));
    return found(c, read && selectRunInspect(read.run, read.events), "run");
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id/units/:unit_id", async (c) => { try {
    const read = await readRun(db, c.req.param("run_id"));
    return found(c, read && selectRunUnitView(read, c.req.param("unit_id")), "unit");
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id/units/:unit_id/artifacts/:artifact", async (c) => { try {
    const read = await readRun(db, c.req.param("run_id"));
    return found(c, read && selectArtifactDetail(read, { unit_id: c.req.param("unit_id"), artifact: c.req.param("artifact") }), "artifact");
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id/units/:unit_id/history", async (c) => { try {
    const limit = pageLimit(c.req.query("limit"));
    if (limit instanceof MalformedRequestError) return errorResponse(limit);
    const after = decodeCursor(c.req.query("cursor"), isTimeCursor, "history");
    if (after instanceof MalformedRequestError) return errorResponse(after);
    const run_id = c.req.param("run_id");
    const unit_id = c.req.param("unit_id") as UnitId;
    const cursor: HistoryCursor | null = after;
    const page = await readHistory(db, { run_id, unit_id, after: cursor, limit });
    if (page === null) return errorResponse(new MissingEntityError("unit not found"));
    return c.json(selectUnitHistory(unit_id, page,
      page.next ? encodeCursor(page.next) : null));
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id/units/:unit_id/diagnostics", async (c) => { try {
    const read = await readUnitDiagnostics(db, { run_id: c.req.param("run_id"), unit_id: c.req.param("unit_id") });
    return found(c, read && selectUnitDiagnostics(read), "unit");
  } catch (cause) { return fault(cause); } });

  app.get("/api/inbox", async (c) => { try {
    const limit = pageLimit(c.req.query("limit"));
    if (limit instanceof MalformedRequestError) return errorResponse(limit);
    const after = decodeCursor(c.req.query("cursor"), isIdCursor, "inbox");
    if (after instanceof MalformedRequestError) return errorResponse(after);
    const page = await listLiveRuns(db, { after, limit });
    return c.json(selectInboxPage(page.items, page.next === null ? null : encodeCursor(page.next)));
  } catch (cause) { return fault(cause); } });

  /** A bounded read for the run list; it also includes archived and completed runs. */
  app.get("/api/run-inboxes", async (c) => { try {
    const ids = c.req.query("ids")?.split(",") ?? [];
    if (ids.length < 1 || ids.length > DEFAULT_PAGE_LIMIT || ids.some((id) => id === ""))
      return errorResponse(new MalformedRequestError("invalid run ids"));
    return c.json(selectRunInboxBatch(await readRunSummaries(db, ids)));
  } catch (cause) { return fault(cause); } });

  /** One run's attention, including archived and runs outside the global inbox page. */
  app.get("/api/runs/:run_id/inbox", async (c) => { try {
    const read = await readRunSummary(db, c.req.param("run_id"));
    return found(c, read && { items: selectRunInboxItems(read), next_cursor: null }, "run");
  } catch (cause) { return fault(cause); } });

  /** Read all units from one consistent run snapshot for workspace recovery. */
  app.get("/api/runs/:run_id/units", async (c) => { try {
    const read = await readRun(db, c.req.param("run_id"));
    return found(c, read && read.units.map((unit) => selectRunUnitView(read, unit.id)), "run");
  } catch (cause) { return fault(cause); } });

  app.get("/api/runs/:run_id/definition", async (c) => { try {
    const pinned = await readPinnedDefinition(db, c.req.param("run_id"));
    return found(c, pinned && selectPinnedDefinition(pinned), "run");
  } catch (cause) { return fault(cause); } });

  app.get("/api/definitions", async (c) => { try {
    const limit = pageLimit(c.req.query("limit"));
    if (limit instanceof MalformedRequestError) return errorResponse(limit);
    const after = decodeCursor(c.req.query("cursor"), definitionCursor, "definitions");
    if (after instanceof MalformedRequestError) return errorResponse(after);
    const is_archived = archivedQuery(c.req.query("archived"));
    if (is_archived instanceof MalformedRequestError) return errorResponse(is_archived);
    const page = await listDefinitions(db, { after, limit, is_archived });
    return c.json({ items: page.items.map(selectDefinitionSummary), next_cursor: page.next === null ? null : encodeCursor(page.next) });
  } catch (cause) { return fault(cause); } });

  app.get("/session_holds/:session_id", async (c) => { try {
    return c.json({ hold: await readSessionHold(db, c.req.param("session_id")) } satisfies SessionHoldResponse);
  } catch (cause) { return fault(cause); } });

  app.get("/api/definitions/:bundle_id", async (c) => { try {
    const definition = await readDefinition(db, c.req.param("bundle_id"));
    return found(c, definition && selectDefinitionDetail(definition), "definition");
  } catch (cause) { return fault(cause); } });
}
