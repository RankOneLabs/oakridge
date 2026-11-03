import type { EligibilityRow } from "../src/grading/eligibility";
import type { QuestionDefinition } from "../src/grading/question";
import type { ItemsPage, Page } from "../src/storage/projection-store";

/** Common serialized listing contract of the items, eligibility and grades APIs. */
export interface ListingPage<Item> extends Page { readonly total: number; readonly items: readonly Item[] }
export async function readAllPages<Item>(read: (offset: number) => Promise<ListingPage<Item>>): Promise<readonly Item[]> {
  const items: Item[] = [];
  for (;;) {
    const page = await read(items.length);
    if (page.offset !== items.length || !Number.isSafeInteger(page.total) || page.total < 0)
      throw new Error("invalid listing position or total");
    if (page.items.length === 0 && items.length < page.total)
      throw new Error("listing ended before its reported total");
    items.push(...page.items);
    if (items.length >= page.total) return items;
  }
}

export interface SubjectSelection {
  readonly run_id: string;
  readonly revision_id: string;
  readonly artifact_kind: "plan" | "brief";
  readonly question: QuestionDefinition;
}
type CapturedSubject = ItemsPage["items"][number];
/** Read only: the caller registers its pinned question before this eligibility query. */
export async function selectGradeSubject(read: (path: string) => Promise<Response>, selection: SubjectSelection): Promise<CapturedSubject> {
  const params = new URLSearchParams({ run_id: selection.run_id, revision_id: selection.revision_id,
    question_id: selection.question.question_id, question_version: selection.question.question_version, limit: "200" });
  const decisions = await readAllPages<EligibilityRow>(async (offset) => {
    params.set("offset", String(offset));
    return (await read(`/v1/evaluation-eligibility?${params}`)).json() as Promise<ListingPage<EligibilityRow>>;
  });
  const eligible = decisions.find((decision) => decision.tag === "eligible");
  if (!eligible) throw new Error(`capture has no eligible ${selection.artifact_kind} criterion for ${selection.question.question_id}`);
  const subject = await (await read(`/v1/items/${encodeURIComponent(eligible.subject_occurrence_id)}`)).json() as CapturedSubject;
  if (subject.run_id !== selection.run_id || subject.revision_id !== selection.revision_id
    || subject.artifact_kind !== selection.artifact_kind || subject.item_kind !== "criterion" || subject.producer_local_id === null)
    throw new Error("eligible subject differs from the captured criterion selection");
  return subject;
}
