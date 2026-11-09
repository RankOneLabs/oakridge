import type { Hono } from "hono";
import type { QuestionId } from "../domain/identity";
import { EVIDENCE_WINDOWS, QUESTION_STATUS_WINDOWS } from "../grading/item-reads";
import { readItemAnswers, readItemAt, readItemEvidence, readItemStatus } from "../storage/grading-record-store";
import { listRunItems, readItem, readLineage, type Page } from "../storage/projection-store";
import type { SourceDependencies } from "./sources";
import { errorResponse } from "./errors";
import { credentialFor } from "./ingest-auth";

const pageFrom = (params: URLSearchParams, limit_key: string, offset_key: string): Page | null => {
  const limit = Number(params.get(limit_key) ?? "50");
  const offset = Number(params.get(offset_key) ?? "0");
  return Number.isInteger(limit) && limit >= 1 && limit <= 200 && Number.isSafeInteger(offset) && offset >= 0 ? { limit, offset } : null;
};
export function pagination(url: string): Page | null {
  return pageFrom(new URL(url).searchParams, "limit", "offset");
}
/** Each nested list's own window, as `<name>_limit` and `<name>_offset`. A reader continues one list
 * while holding the others still; a bad window refuses the whole read rather than silently clamping. */
export function listWindows<Name extends string>(url: string, names: readonly Name[]): Record<Name, Page> | null {
  const params = new URL(url).searchParams;
  const windows = {} as Record<Name, Page>;
  for (const name of names) {
    const page = pageFrom(params, `${name}_limit`, `${name}_offset`);
    if (!page) return null;
    windows[name] = page;
  }
  return windows;
}
const INVALID = "limit must be 1..200 and offset nonnegative, for the list and for each nested list";

export function registerItemRoutes(app: Hono, deps: SourceDependencies): void {
  app.get("/v1/runs/:run_id/items", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    const windows = listWindows(c.req.url, ["issues"]);
    if (!page || !windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    return c.json(await listRunItems(deps.db, credential, c.req.param("run_id"), page, windows.issues));
  });
  /** One item by its exact source revision and path. Needs no link or tracked item. */
  app.get("/v1/runs/:run_id/items/at", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const source_revision_id = c.req.query("source_revision_id");
    const item_path = c.req.query("item_path");
    if (!source_revision_id || !item_path) return errorResponse(c, 400, "invalid_address", "source_revision_id and item_path are required");
    const item = await readItemAt(deps.db, credential, deps.profile.composite, { run_id: c.req.param("run_id"), source_revision_id, item_path });
    return item ? c.json(item) : errorResponse(c, 404, "not_found", "no item is captured at this revision and path");
  });
  app.get("/v1/items/:id/lineage", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const lineage = await readLineage(deps.db, credential, c.req.param("id"), page);
    return lineage ? c.json(lineage) : errorResponse(c, 404, "not_found", "item not found");
  });
  /** Each pinned question of an item: its own readiness, frozen evidence, each machine evaluator's
   * distinct state, and every answer with its correction history. */
  app.get("/v1/items/:id/status", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const windows = listWindows(c.req.url, [...QUESTION_STATUS_WINDOWS, "links"]);
    const questions = pagination(c.req.url);
    if (!windows || !questions) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const status = await readItemStatus(deps.db, credential, deps.profile.composite, c.req.param("id"), { ...windows, questions });
    return status ? c.json(status) : errorResponse(c, 404, "not_found", "item not found");
  });
  /** An item's answers, narrowable to one question or one reviewer, each marked current or replaced. */
  app.get("/v1/items/:id/answers", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    if (!page) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const question_id = c.req.query("question_id"), question_version = c.req.query("question_version");
    if ((question_id === undefined) !== (question_version === undefined)) return errorResponse(c, 400, "invalid_question", "question_id and question_version go together");
    const answers = await readItemAnswers(deps.db, credential, c.req.param("id"), { page, reviewer_id: c.req.query("reviewer_id") ?? null,
      question: question_id && question_version ? { question_id: question_id as QuestionId, question_version } : null });
    return answers ? c.json(answers) : errorResponse(c, 404, "not_found", "item not found");
  });
  /** Each question pinned to an item at capture: its version, evaluator set and own readiness. */
  app.get("/v1/items/:id/evidence", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const page = pagination(c.req.url);
    const windows = listWindows(c.req.url, EVIDENCE_WINDOWS);
    if (!page || !windows) return errorResponse(c, 400, "invalid_pagination", INVALID);
    const evidence = await readItemEvidence(deps.db, credential, c.req.param("id"), page, windows);
    return evidence ? c.json(evidence) : errorResponse(c, 404, "not_found", "item not found");
  });
  app.get("/v1/items/:id", async (c) => {
    const credential = credentialFor(c.req.header("authorization"), deps.credentials.read);
    if (!credential) return errorResponse(c, 403, "forbidden", "read credential required");
    const item = await readItem(deps.db, credential, c.req.param("id"));
    return item ? c.json(item) : errorResponse(c, 404, "not_found", "item not found");
  });
}
