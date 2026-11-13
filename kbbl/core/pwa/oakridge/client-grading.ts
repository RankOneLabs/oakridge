import type { ObservationEvaluatorDefinition } from "./grading-contracts/grading/evaluator";
import type { ObservationRunStageRead } from "./grading-contracts/grading/task-stages";
// Observation reads and the one submission, through kbbl's forwarding routes. The browser holds no
// observation token: kbbl authenticates the operator and supplies the matching capability.
import type { ObservationItemOccurrenceId, ObservationLogicalItemId, ObservationReviewerId } from "./grading-contracts/domain/identity";
import type { ObservationCompositeDrilldownKey, ObservationLogicalItemLineage, ObservationPageRequest, ObservationPaged } from "./grading-contracts/grading/composite";
import type { ObservationAddressedItem, ObservationAnswerRead, ObservationCompositeRead, ObservationDrilldownRowRead, ObservationGradeableItemRow, ObservationItemAddress, ObservationUnresolvedReferenceRead } from "./grading-contracts/grading/item-reads";
import type { ObservationQuestionKey } from "./grading-contracts/grading/question";
import type { ObservationHumanSubmissionAcknowledgment, ObservationHumanSubmissionRequest, ObservationReviewerRead } from "./grading-contracts/http/grades";
import type { ObservationRunSpend } from "./grading-contracts/storage/execution-store";
import type { ObservationItemStatusResponse } from "./grading-contracts/storage/grading-record-store";
import type { ObservationLineagePage } from "./grading-contracts/storage/projection-store";
import type { SubmissionResult } from "./grading-types";

const ROOT = "/oakridge/observation";
export class GradingReadError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "GradingReadError"; }
}
interface ServiceFailure { readonly error?: string | { readonly code?: string; readonly message?: string } }
const failureOf = (body: unknown, fallback: string): { readonly code: string; readonly message: string } => {
  const error = (body as ServiceFailure | null)?.error;
  if (typeof error === "string") return { code: error, message: error };
  return { code: error?.code ?? "unavailable", message: error?.message ?? fallback };
};
export type WindowQuery = Readonly<Record<string, ObservationPageRequest | undefined>>;
/** `top` is the list's own window; each named list has its own `<name>_limit` and `<name>_offset`. */
const windowParams = (top: ObservationPageRequest | null, nested: WindowQuery = {}): URLSearchParams => {
  const params = new URLSearchParams();
  if (top) { params.set("limit", String(top.limit)); params.set("offset", String(top.offset)); }
  for (const [name, window] of Object.entries(nested)) if (window) {
    params.set(`${name}_limit`, String(window.limit));
    params.set(`${name}_offset`, String(window.offset));
  }
  return params;
};
async function read<Value>(path: string, params: URLSearchParams = new URLSearchParams()): Promise<Value> {
  const query = params.toString();
  const response = await fetch(`${ROOT}${path}${query ? `?${query}` : ""}`);
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok) {
    const failure = failureOf(body, `observation ${path}: ${response.status}`);
    throw new GradingReadError(response.status, failure.code, failure.message);
  }
  return body as Value;
}
const id = encodeURIComponent;
const taskParams = (params: URLSearchParams, task_id?: ObservationLogicalItemId | null): URLSearchParams => {
  if (task_id) params.set("task_id", task_id);
  return params;
};

export const readItemAt = (run_id: string, selection: ObservationItemAddress): Promise<ObservationAddressedItem> =>
  read(`/runs/${id(run_id)}/items/at`, new URLSearchParams({ source_revision_id: selection.source_revision_id, item_path: selection.item_path }));
/** One item's status: its questions' own window and every nested list's. */
export interface ItemStatusRequest { readonly occurrence_id: ObservationItemOccurrenceId; readonly task_id?: ObservationLogicalItemId | null; readonly top: ObservationPageRequest; readonly nested: WindowQuery }
export const readItemStatus = ({ occurrence_id, task_id, top, nested }: ItemStatusRequest): Promise<ObservationItemStatusResponse> =>
  read(`/items/${id(occurrence_id)}/status`, taskParams(windowParams(top, nested), task_id));
export const readItemLineage = (occurrence_id: ObservationItemOccurrenceId, top: ObservationPageRequest, task_id?: ObservationLogicalItemId | null): Promise<ObservationLineagePage> =>
  read(`/items/${id(occurrence_id)}/lineage`, taskParams(windowParams(top), task_id));
export const readReviewer = (): Promise<ObservationReviewerRead> => read("/reviewer");
export function readAnswersPage(occurrence_id: ObservationItemOccurrenceId, filter: { readonly question: ObservationQuestionKey; readonly task_id?: ObservationLogicalItemId | null; readonly reviewer_id: ObservationReviewerId }, page: ObservationPageRequest): Promise<ObservationPaged<ObservationAnswerRead>> {
  const params = taskParams(windowParams(page), filter.task_id);
  params.set("question_id", filter.question.question_id);
  params.set("question_version", filter.question.question_version);
  params.set("reviewer_id", filter.reviewer_id);
  return read(`/items/${id(occurrence_id)}/answers`, params);
}
export const readRunGrading = (run_id: string): Promise<ObservationRunSpend> => read(`/runs/${id(run_id)}/grading`);
export function readRunFindings(run_id: string, query: { readonly stage: string; readonly is_current_only: boolean; readonly page: ObservationPageRequest; readonly links: ObservationPageRequest }): Promise<ObservationPaged<ObservationGradeableItemRow>> {
  const params = windowParams(query.page, { links: query.links });
  params.set("stage", query.stage);
  if (!query.is_current_only) params.set("revisions", "all");
  return read(`/runs/${id(run_id)}/findings`, params);
}
export const readRunUnresolved = (run_id: string, page: ObservationPageRequest): Promise<ObservationPaged<ObservationUnresolvedReferenceRead>> =>
  read(`/runs/${id(run_id)}/unresolved-task-references`, windowParams(page));
/** No occurrence filter exists on this read: exhaust every run page before reporting this item's references. */
export async function readItemUnresolved(run_id: string, occurrence_id: ObservationItemOccurrenceId): Promise<readonly ObservationUnresolvedReferenceRead[]> {
  const rows: ObservationUnresolvedReferenceRead[] = [];
  let offset = 0;
  while (true) {
    const page = await readRunUnresolved(run_id, { limit: 200, offset });
    rows.push(...page.items.filter(({ item }) => item.occurrence_id === occurrence_id));
    const nextOffset = offset + page.items.length;
    if (nextOffset >= page.total) return rows;
    // A truncated response must not turn an incomplete scan into a false empty result.
    if (nextOffset === offset) throw new GradingReadError(502, "incomplete_page", "Unresolved task reference read did not advance.");
    offset = nextOffset;
  }
}
/** A page of a run's tasks. Each nested window applies to that list in every task on the page. */
export interface RunTasksRequest { readonly run_id: string; readonly page: ObservationPageRequest; readonly nested: WindowQuery }
export const readRunTasks = ({ run_id, page, nested }: RunTasksRequest): Promise<ObservationPaged<ObservationCompositeRead>> =>
  read(`/runs/${id(run_id)}/tasks`, windowParams(page, nested));
/** One task of a run, with its nested windows. */
export interface TaskRequest { readonly run_id: string; readonly task_id: string; readonly nested: WindowQuery }
export const readTask = ({ run_id, task_id, nested }: TaskRequest): Promise<ObservationCompositeRead> =>
  read(`/runs/${id(run_id)}/tasks/${id(task_id)}`, windowParams(null, nested));
export const readTaskLineage = (run_id: string, task_id: string, page: ObservationPageRequest): Promise<ObservationLogicalItemLineage> =>
  read(`/runs/${id(run_id)}/tasks/${id(task_id)}/lineage`, windowParams(page));
/** The rows behind one composite count. */
export interface DrilldownRequest { readonly run_id: string; readonly key: ObservationCompositeDrilldownKey; readonly page: ObservationPageRequest; readonly nested: WindowQuery }
export function readDrilldown({ run_id, key, page, nested }: DrilldownRequest): Promise<ObservationPaged<ObservationDrilldownRowRead>> {
  const params = windowParams(page, nested);
  params.set("key", JSON.stringify(key));
  return read(`/runs/${id(run_id)}/drilldown`, params);
}

/** Never throws: the caller tells acknowledged, refused and unknown apart, and says saved only on the first. */
export async function submitAnswer(occurrence_id: ObservationItemOccurrenceId, submission: ObservationHumanSubmissionRequest): Promise<SubmissionResult> {
  try {
    const response = await fetch(`${ROOT}/items/${id(occurrence_id)}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission) });
    const body = await response.json().catch(() => null) as unknown;
    if (response.ok && body !== null) return { kind: "acknowledged", acknowledgment: body as ObservationHumanSubmissionAcknowledgment };
    if (response.status >= 500 || response.ok) return { kind: "failed", message: failureOf(body, `observation answered ${response.status}`).message };
    return { kind: "refused", ...failureOf(body, `observation refused the answer (${response.status})`) };
  } catch (cause) {
    return { kind: "failed", message: cause instanceof Error ? cause.message : "the request did not complete" };
  }
}

export const readRunStages = (run_id: string): Promise<readonly ObservationRunStageRead[]> => read(`/runs/${id(run_id)}/stages`);

/** Read the immutable definition that actually graded the item. */
export const readEvaluatorDefinition = (evaluator_id: string): Promise<ObservationEvaluatorDefinition> =>
  read(`/evaluator-definitions/${id(evaluator_id)}`);
