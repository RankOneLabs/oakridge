import { err, ok, type Result } from "../domain/primitives";
import type { LinkReference, SelectedItem } from "../projection/extractor";
import { CRITERION_SCOPE } from "../projection/catalogue/oakridge-development";
import type { ExclusionReason } from "./population-manifest";

/** Items a plan criterion may cite. Decisions share the criterion's own plan revision, so they are
 * always captured; `tasks` is null when the run's tasks revision was not captured. */
export interface TraceabilitySources {
  readonly tasks: readonly SelectedItem[] | null;
  readonly plan_decisions: readonly SelectedItem[];
}
export type TraceabilityEligibility =
  | { readonly kind: "eligible"; readonly tasks: readonly SelectedItem[]; readonly decisions: readonly SelectedItem[] }
  /** Cited tasks cannot be resolved because their revision is missing; graded as incomplete evidence. */
  | { readonly kind: "tasks_uncaptured"; readonly decisions: readonly SelectedItem[] }
  | { readonly kind: "uncited" }
  | { readonly kind: "dangling_citation"; readonly evidence_refs: readonly string[] };
export interface TraceabilityError { readonly operation: "plan_traceability"; readonly entity_id: string; readonly detail: string }

function citations(criterion: SelectedItem, artifact_kind: "tasks" | "plan", item_kind: "task" | "decision"): readonly LinkReference[] {
  return criterion.links.filter((link) => link.type === "derived_from" && link.target_artifact_kind === artifact_kind
    && link.target_item_kind === item_kind);
}
function resolve(links: readonly LinkReference[], item_kind: string, items: readonly SelectedItem[])
  : { readonly resolved: readonly SelectedItem[]; readonly dangling: readonly string[] } {
  const matches = links.map((link) => ({ link, item: items.find((item) => item.item_kind === item_kind
    && item.item_scope === link.target_scope && item.producer_local_id === link.target_local_id) }));
  return { resolved: matches.flatMap(({ item }) => item ? [item] : []),
    dangling: matches.flatMap(({ link, item }) => item ? [] : [link.evidence_ref]) };
}

/** Decide, before any grader runs, whether a plan criterion's own citations can be traced. */
export function planCriterionEligibility(criterion: SelectedItem, sources: TraceabilitySources)
  : Result<TraceabilityEligibility, TraceabilityError> {
  if (criterion.item_kind !== "criterion" || criterion.item_scope !== CRITERION_SCOPE || !criterion.producer_local_id)
    return err({ operation: "plan_traceability", entity_id: criterion.item_id_or_path,
      detail: "subject must be a run-scoped plan criterion" });
  const task_links = citations(criterion, "tasks", "task");
  const decision_links = citations(criterion, "plan", "decision");
  if (task_links.length === 0 && decision_links.length === 0) return ok({ kind: "uncited" });
  const decisions = resolve(decision_links, "decision", sources.plan_decisions);
  if (sources.tasks === null) return decisions.dangling.length > 0
    ? ok({ kind: "dangling_citation", evidence_refs: decisions.dangling })
    : ok(task_links.length > 0 ? { kind: "tasks_uncaptured", decisions: decisions.resolved }
      : { kind: "eligible", tasks: [], decisions: decisions.resolved });
  const tasks = resolve(task_links, "task", sources.tasks);
  const dangling = [...tasks.dangling, ...decisions.dangling];
  return ok(dangling.length > 0 ? { kind: "dangling_citation", evidence_refs: dangling }
    : { kind: "eligible", tasks: tasks.resolved, decisions: decisions.resolved });
}

/** Uncited and dangling criteria leave the population; the other outcomes are graded. */
export function traceabilityExclusion(eligibility: TraceabilityEligibility): ExclusionReason | null {
  switch (eligibility.kind) {
    case "uncited": return { kind: "uncited" };
    case "dangling_citation": return { kind: "dangling_citation", evidence_refs: eligibility.evidence_refs };
    case "eligible":
    case "tasks_uncaptured": return null;
  }
}
