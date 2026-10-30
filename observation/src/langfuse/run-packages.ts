import { canonicalDigest } from "../canonical/canonical-json";
import type { EvidenceSetId, ItemOccurrenceId } from "../domain/identity";
import { err, ok, type Result } from "../domain/primitives";
import type { EvidenceReference, EvidenceSet } from "../grading/evidence";
import type { SelectedItem } from "../projection/extractor";
import type { PilotQuestionId } from "./evidence-recipe";
import { planCriterionEligibility } from "./plan-traceability";
import type { ExclusionReason } from "./population-manifest";

/** A captured item with the occurrence the service stored for it. */
export interface CapturedItem extends SelectedItem { readonly occurrence_id: ItemOccurrenceId }
export interface CapturedRevision {
  readonly revision_id: string;
  readonly unit_id: string;
  readonly artifact_kind: string;
  readonly recorded_at: Date;
  readonly items: readonly CapturedItem[];
}
/** One subject item, its question, and the evidence a native evaluator reads. */
export interface PilotPackage {
  readonly question_id: PilotQuestionId;
  readonly subject: CapturedItem;
  readonly revision_id: string;
  readonly evidence: EvidenceSet;
}
export interface PackageExclusion {
  readonly question_id: PilotQuestionId;
  readonly occurrence_id: ItemOccurrenceId;
  readonly reason: ExclusionReason;
}
export interface RunPackages {
  readonly packages: readonly PilotPackage[];
  readonly exclusions: readonly PackageExclusion[];
}
export interface RunPackageError { readonly operation: "run_packages"; readonly entity_id: string; readonly detail: string }

/** The latest revision of each artifact kind in each unit; earlier revisions were superseded. */
export function latestRevisions(revisions: readonly CapturedRevision[]): readonly CapturedRevision[] {
  const latest = new Map<string, CapturedRevision>();
  for (const revision of revisions) {
    const key = `${revision.unit_id}\u0000${revision.artifact_kind}`;
    const current = latest.get(key);
    if (!current || revision.recorded_at > current.recorded_at) latest.set(key, revision);
  }
  return [...latest.values()].sort((a, b) => a.revision_id.localeCompare(b.revision_id));
}

/** Refs lead with their recipe role so an evaluator can tell the subject from its sources. */
function reference(role: string, item: CapturedItem): Result<EvidenceReference, RunPackageError> {
  const digest = canonicalDigest(item.selected_value);
  if (!digest.ok) return err({ operation: "run_packages", entity_id: item.occurrence_id, detail: digest.error.detail });
  return ok({ ref: `${role}:${item.producer_local_id ?? item.item_id_or_path}`, kind: "public",
    content: item.selected_value, digest: digest.value });
}
function evidenceSet(question_id: PilotQuestionId, references: readonly EvidenceReference[],
  incompleteness_reason: string | null): Result<EvidenceSet, RunPackageError> {
  const id = canonicalDigest([question_id, references, incompleteness_reason]);
  if (!id.ok) return err({ operation: "run_packages", entity_id: question_id, detail: id.error.detail });
  return ok({ evidence_set_id: id.value as unknown as EvidenceSetId, references,
    is_incomplete: incompleteness_reason !== null, incompleteness_reason });
}
function collect(results: readonly Result<EvidenceReference, RunPackageError>[]): Result<readonly EvidenceReference[], RunPackageError> {
  const references: EvidenceReference[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    references.push(result.value);
  }
  return ok(references);
}
function itemsOf(revisions: readonly CapturedRevision[], artifact_kind: string, item_kind: string): readonly CapturedItem[] {
  return revisions.filter((revision) => revision.artifact_kind === artifact_kind)
    .flatMap((revision) => revision.items.filter((item) => item.item_kind === item_kind));
}

/** Plan criteria are packaged with the tasks and decisions they cite; uncited and dangling ones are excluded. */
function planPackages(latest: readonly CapturedRevision[]): Result<RunPackages, RunPackageError> {
  const task_revisions = latest.filter((revision) => revision.artifact_kind === "tasks");
  const tasks = task_revisions.length === 0 ? null : itemsOf(task_revisions, "tasks", "task");
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  for (const revision of latest.filter((candidate) => candidate.artifact_kind === "plan")) {
    const decisions = revision.items.filter((item) => item.item_kind === "decision");
    for (const criterion of revision.items.filter((item) => item.item_kind === "criterion")) {
      const eligibility = planCriterionEligibility(criterion, { tasks, plan_decisions: decisions });
      if (!eligibility.ok) return err({ operation: "run_packages", entity_id: criterion.occurrence_id, detail: eligibility.error.detail });
      const outcome = eligibility.value;
      if (outcome.kind === "uncited" || outcome.kind === "dangling_citation") {
        exclusions.push({ question_id: "plan.criterion_traceability", occurrence_id: criterion.occurrence_id,
          reason: outcome.kind === "uncited" ? { kind: "uncited" } : { kind: "dangling_citation", evidence_refs: outcome.evidence_refs } });
        continue;
      }
      const cited = outcome.kind === "eligible" ? outcome.tasks : [];
      const references = collect([reference("plan_criterion", criterion),
        ...cited.map((task) => reference("plan_task", task)),
        ...outcome.decisions.map((decision) => reference("plan_decision", decision))]);
      if (!references.ok) return references;
      const evidence = evidenceSet("plan.criterion_traceability", references.value,
        outcome.kind === "tasks_uncaptured" ? "the run's tasks revision was not captured" : null);
      if (!evidence.ok) return evidence;
      packages.push({ question_id: "plan.criterion_traceability", subject: criterion, revision_id: revision.revision_id,
        evidence: evidence.value });
    }
  }
  return ok({ packages, exclusions });
}

/** Brief criteria are packaged with the plan criterion their derived_from link names. */
function briefPackages(latest: readonly CapturedRevision[]): Result<RunPackages, RunPackageError> {
  const plan_criteria = itemsOf(latest, "plan", "criterion");
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  for (const revision of latest.filter((candidate) => candidate.artifact_kind === "brief")) {
    for (const criterion of revision.items.filter((item) => item.item_kind === "criterion")) {
      const link = criterion.links.find((candidate) => candidate.type === "derived_from"
        && candidate.target_artifact_kind === "plan" && candidate.target_item_kind === "criterion");
      const source = link ? plan_criteria.find((item) => item.item_scope === link.target_scope
        && item.producer_local_id === link.target_local_id) : undefined;
      if (!link || !source) {
        exclusions.push({ question_id: "brief.source_fidelity", occurrence_id: criterion.occurrence_id,
          reason: { kind: "dangling_citation", evidence_refs: [link?.evidence_ref ?? criterion.path] } });
        continue;
      }
      const references = collect([reference("plan_criterion", source), reference("brief_criterion", criterion)]);
      if (!references.ok) return references;
      const evidence = evidenceSet("brief.source_fidelity", references.value, null);
      if (!evidence.ok) return evidence;
      packages.push({ question_id: "brief.source_fidelity", subject: criterion, revision_id: revision.revision_id,
        evidence: evidence.value });
    }
  }
  return ok({ packages, exclusions });
}

/** Every package a native evaluator can grade for one captured run, plus what was excluded and why. */
export function runPackages(revisions: readonly CapturedRevision[]): Result<RunPackages, RunPackageError> {
  const latest = latestRevisions(revisions);
  const plan = planPackages(latest);
  if (!plan.ok) return plan;
  const brief = briefPackages(latest);
  if (!brief.ok) return brief;
  return ok({ packages: [...plan.value.packages, ...brief.value.packages],
    exclusions: [...plan.value.exclusions, ...brief.value.exclusions] });
}
