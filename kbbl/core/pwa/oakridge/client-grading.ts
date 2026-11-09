// Observation reads and the one submission, through kbbl's forwarding routes. The browser holds no
// observation token: kbbl authenticates the operator and supplies the matching capability.
import type { AnswerRead, AnswerSubmission, AddressedItem, DrilldownKey, DrilldownRow, FindingRow, ItemLineage, ItemSelection, ItemStatus, PageWindow, Paged, QuestionKey, RunGradingState,
  SubmissionAcknowledgment, SubmissionResult, TaskComposite, TaskLineage, UnresolvedTaskReference } from "./grading-types";

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
export type WindowQuery = Readonly<Record<string, PageWindow | undefined>>;
/** `top` is the list's own window; each named list has its own `<name>_limit` and `<name>_offset`. */
const windowParams = (top: PageWindow | null, nested: WindowQuery = {}): URLSearchParams => {
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

export const readItemAt = (run_id: string, selection: ItemSelection): Promise<AddressedItem> =>
  read(`/runs/${id(run_id)}/items/at`, new URLSearchParams({ source_revision_id: selection.source_revision_id, item_path: selection.item_path }));
export const readItemStatus = (occurrence_id: string, top: PageWindow, nested: WindowQuery): Promise<ItemStatus> =>
  read(`/items/${id(occurrence_id)}/status`, windowParams(top, nested));
export const readItemLineage = (occurrence_id: string, top: PageWindow): Promise<ItemLineage> =>
  read(`/items/${id(occurrence_id)}/lineage`, windowParams(top));
export const readReviewer = (): Promise<{ readonly reviewer_id: string }> => read("/reviewer");
export function readAnswersPage(occurrence_id: string, filter: { readonly question: QuestionKey; readonly reviewer_id: string }, page: PageWindow): Promise<Paged<AnswerRead>> {
  const params = windowParams(page);
  params.set("question_id", filter.question.question_id);
  params.set("question_version", filter.question.question_version);
  params.set("reviewer_id", filter.reviewer_id);
  return read(`/items/${id(occurrence_id)}/answers`, params);
}
export const readRunGrading = (run_id: string): Promise<RunGradingState> => read(`/runs/${id(run_id)}/grading`);
export function readRunFindings(run_id: string, query: { readonly stage: string; readonly is_current_only: boolean; readonly page: PageWindow; readonly links: PageWindow }): Promise<Paged<FindingRow>> {
  const params = windowParams(query.page, { links: query.links });
  params.set("stage", query.stage);
  if (!query.is_current_only) params.set("revisions", "all");
  return read(`/runs/${id(run_id)}/findings`, params);
}
export const readRunUnresolved = (run_id: string, page: PageWindow): Promise<Paged<UnresolvedTaskReference>> =>
  read(`/runs/${id(run_id)}/unresolved-task-references`, windowParams(page));
export const readRunTasks = (run_id: string, page: PageWindow, nested: WindowQuery): Promise<Paged<TaskComposite>> =>
  read(`/runs/${id(run_id)}/tasks`, windowParams(page, nested));
export const readTask = (run_id: string, task_id: string, nested: WindowQuery): Promise<TaskComposite> =>
  read(`/runs/${id(run_id)}/tasks/${id(task_id)}`, windowParams(null, nested));
export const readTaskLineage = (run_id: string, task_id: string, page: PageWindow): Promise<TaskLineage> =>
  read(`/runs/${id(run_id)}/tasks/${id(task_id)}/lineage`, windowParams(page));
export function readDrilldown(run_id: string, key: DrilldownKey, page: PageWindow, nested: WindowQuery): Promise<Paged<DrilldownRow>> {
  const params = windowParams(page, nested);
  params.set("key", JSON.stringify(key));
  return read(`/runs/${id(run_id)}/drilldown`, params);
}

/** Never throws: the caller tells acknowledged, refused and unknown apart, and says saved only on the first. */
export async function submitAnswer(occurrence_id: string, submission: AnswerSubmission): Promise<SubmissionResult> {
  try {
    const response = await fetch(`${ROOT}/items/${id(occurrence_id)}/answers`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(submission) });
    const body = await response.json().catch(() => null) as unknown;
    if (response.ok && body !== null) return { kind: "acknowledged", acknowledgment: body as SubmissionAcknowledgment };
    if (response.status >= 500 || response.ok) return { kind: "failed", message: failureOf(body, `observation answered ${response.status}`).message };
    return { kind: "refused", ...failureOf(body, `observation refused the answer (${response.status})`) };
  } catch (cause) {
    return { kind: "failed", message: cause instanceof Error ? cause.message : "the request did not complete" };
  }
}
