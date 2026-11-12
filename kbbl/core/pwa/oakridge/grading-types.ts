// What only the browser has. Every observation request and response body is generated into
// grading-contracts/ from observation/src/http/grading-api.ts; nothing here mirrors one.
import type { ObservationHumanSubmissionAcknowledgment } from "./grading-contracts/http/grades";

/** The nested lists an item status read pages, each by `<name>_limit` and `<name>_offset`. */
export type ItemStatusWindowName = "questions" | "references" | "pinned_evaluators" | "machine" | "attempts" | "answers" | "superseded_answers" | "links";
/** The nested lists a task composite read pages. */
export type CompositeWindowName = "stages" | "unit_ids" | "questions" | "answers" | "statuses" | "disagreements" | "results";
/** The nested lists a drilldown read pages. */
export type DrilldownWindowName = "questions" | "links" | "statuses" | "answers" | "superseded_answers" | "references" | "pinned_evaluators" | "results";

/** What became of one submission, as this browser knows it. */
export type SubmissionResult =
  | { readonly kind: "acknowledged"; readonly acknowledgment: ObservationHumanSubmissionAcknowledgment }
  /** The service answered and recorded nothing, saying why. */
  | { readonly kind: "refused"; readonly code: string; readonly message: string }
  /** No answer came back, so nothing is known to be saved. */
  | { readonly kind: "failed"; readonly message: string };
