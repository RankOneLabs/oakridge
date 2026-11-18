import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { assignmentSchema, parseCurrent, type ResolvedAssignment } from "./current-contract";
export interface ReceivedContext {
  readonly assignment: ResolvedAssignment;
  readonly sources: readonly { readonly input: string; readonly revision_id: string; readonly unit: string }[];
  readonly provenance_status: "recorded" | "unresolved";
}
/** Reads only the pinned resolved assignment, never joins the current plan/spec. */
export function selectReceivedContext(unit: Pick<OperatorUnitView, "input" | "input_provenance">): ReceivedContext | null {
  const input = unit.input;
  if (!input || typeof input !== "object" || Array.isArray(input) || !("assignment" in input)) return null;
  const parsed = parseCurrent(assignmentSchema, input.assignment, "parse_received_context");
  if (!parsed.ok) return null;
  return { assignment: { ...parsed.value, requirements: parsed.value.requirements.filter((requirement) => parsed.value.cohort.allocations.some((allocation) => allocation.requirement_id === requirement.id)) }, sources: unit.input_provenance?.status === "recorded" ? unit.input_provenance.entries : [],
    provenance_status: unit.input_provenance?.status === "recorded" ? "recorded" : "unresolved" };
}

export function selectRevisionReceivedContext(unit: OperatorUnitView, attemptId: string | null): ReceivedContext | null {
  const intent = unit.attempts.find((attempt) => attempt.id === attemptId)?.intent;
  return intent ? selectReceivedContext({ input: intent.inputs, input_provenance: intent.input_provenance }) : selectReceivedContext(unit);
}
