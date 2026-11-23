import type { OperatorUnitView } from "../operator-contracts/projections/unit-view";
import { readAssignment, type ResolvedAssignment } from "./viewer-data";
export interface ReceivedContext {
  readonly assignment: ResolvedAssignment;
  readonly sources: readonly { readonly input: string; readonly revision_id: string; readonly unit: string }[];
  readonly provenance_status: "recorded" | "unresolved";
}
/** Reads only the pinned resolved assignment, never joins the current plan/spec. */
export function selectReceivedContext(unit: Pick<OperatorUnitView, "input" | "input_provenance">): ReceivedContext | null {
  const input = unit.input;
  if (!input || typeof input !== "object" || Array.isArray(input) || !("assignment" in input)) return null;
  const parsed = readAssignment(input.assignment);
  if (!parsed) return null;
  return { assignment: { ...parsed, requirements: parsed.requirements.filter((requirement) => parsed.cohort.allocations.some((allocation) => allocation.requirement_id === requirement.id)) }, sources: unit.input_provenance?.status === "recorded" ? unit.input_provenance.entries : [],
    provenance_status: unit.input_provenance?.status === "recorded" ? "recorded" : "unresolved" };
}

export function selectRevisionReceivedContext(unit: OperatorUnitView, attemptId: string | null): ReceivedContext | null {
  const intent = unit.attempts.find((attempt) => attempt.id === attemptId)?.intent;
  return intent ? selectReceivedContext({ input: intent.inputs, input_provenance: intent.input_provenance }) : selectReceivedContext(unit);
}

export interface ReceivedContextView extends ReceivedContext { readonly dependencies_text: string; readonly requirements: readonly (ResolvedAssignment["requirements"][number] & { readonly source_revisions_text: string })[] }
export function selectReceivedContextView(context: ReceivedContext): ReceivedContextView {
  const revisions = context.sources.filter((source) => source.input === "assignment").map((source) => source.revision_id);
  return { ...context, dependencies_text: context.assignment.cohort.depends_on.join(", ") || "None",
    requirements: context.assignment.requirements.map((requirement) => ({ ...requirement, source_revisions_text: revisions.join(", ") || "Not recorded" })),
  };
}
