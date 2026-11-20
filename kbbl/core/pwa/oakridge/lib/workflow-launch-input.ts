import type { Result } from "../../lib/result";
import type { StudySliceLimits, WorkflowLaunchInput } from "../launch-types";

/** Study's slice limits as the operator types them; the cap is in dollars. */
export interface StudySliceDraft {
  readonly case_limit: string;
  readonly cap_dollars: string;
}
/** The limits study's own tests launch with: six pilot cases and a $10 paid slice. */
export const DEFAULT_STUDY_SLICE_DRAFT: StudySliceDraft = { case_limit: "6", cap_dollars: "10.00" };
export interface LaunchInputRefusal { readonly detail: string }

const refuse = (detail: string): Result<never, LaunchInputRefusal> => ({ ok: false, error: { detail } });
const WHOLE = /^\d+$/;
const DOLLARS = /^(\d+)(?:\.(\d{1,2}))?$/;

/** At least one case, and a cap of at least one cent, in whole cents; a number too large to send exactly is refused. */
export function selectStudySliceLimits(draft: StudySliceDraft): Result<StudySliceLimits, LaunchInputRefusal> {
  const caseLimit = draft.case_limit.trim();
  const cases = Number(caseLimit);
  if (!WHOLE.test(caseLimit) || !Number.isSafeInteger(cases) || cases < 1) return refuse("Slice case limit must be a whole number of at least 1.");
  const dollars = DOLLARS.exec(draft.cap_dollars.trim());
  if (!dollars) return refuse("Slice spending cap must be an amount in dollars, such as 10 or 12.50.");
  const cents = Number(dollars[1]) * 100 + Number((dollars[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents)) return refuse("Slice spending cap is too large.");
  if (cents < 1) return refuse("Slice spending cap must be more than $0.");
  return { ok: true, value: { slice_case_limit: cases, slice_cap_cents: cents } };
}

export interface WorkflowLaunchInputDraft {
  /** The selected definition's workflow name, null until definitions load. */
  readonly workflow_name: string | null;
  readonly study_slice: StudySliceDraft;
}
/** What the selected workflow takes beyond the shared launch fields. */
export function selectWorkflowLaunchInput(draft: WorkflowLaunchInputDraft): Result<WorkflowLaunchInput, LaunchInputRefusal> {
  if (draft.workflow_name === "development") return { ok: true, value: { kind: "development" } };
  if (draft.workflow_name !== "study") return refuse(`The PWA cannot launch the ${draft.workflow_name ?? "selected"} workflow.`);
  const slice = selectStudySliceLimits(draft.study_slice);
  return slice.ok ? { ok: true, value: { kind: "study", slice: slice.value } } : slice;
}
