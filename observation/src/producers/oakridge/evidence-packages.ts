import { err, ok, type Result } from "../../domain/primitives";
import type { ItemOccurrenceId } from "../../domain/identity";
import type { EvidenceKind, EvidenceSet } from "../../grading/evidence";
import { collectReferences, capturedReference, packagedEvidenceSet, type EvidencePackageError } from "../../grading/evidence-packages/references";
import { selectCapturedRevisions, type CapturedItem, type CapturedRevision, type RevisionSelection } from "../../grading/evidence-packages/capture";
import { planCriterionEligibility } from "./plan-traceability";
import type { EligibilityDecision, ExclusionReason } from "../../grading/eligibility";
import type { PilotQuestionId } from "../../grading/evidence-packages/pilot-recipe";
import { LANGFUSE_PILOT_QUESTIONS } from "../../grading/catalogue/langfuse-pilot";

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
  readonly selection_policy: RevisionSelection["policy"];
  readonly packages: readonly PilotPackage[];
  readonly exclusions: readonly PackageExclusion[];
  readonly eligibility: readonly PackageEligibility[];
}
export interface PackageEligibility {
  readonly question_id: PilotQuestionId;
  readonly occurrence_id: ItemOccurrenceId;
  readonly decision: EligibilityDecision;
}
export type RunPackageError = EvidencePackageError;

function itemsOf(revisions: readonly CapturedRevision[], artifact_kind: string, item_kind: string): readonly CapturedItem[] {
  return revisions.filter((revision) => revision.artifact_kind === artifact_kind)
    .flatMap((revision) => revision.items.filter((item) => item.item_kind === item_kind));
}

/** A brief sees the most recent matching plan that existed at its capture time. */
function planAtBrief(revisions: readonly CapturedRevision[], brief: CapturedRevision): CapturedRevision | undefined {
  return revisions.filter((revision) => revision.artifact_kind === "plan" && revision.recorded_at <= brief.recorded_at)
    .sort((a, b) => b.recorded_at.getTime() - a.recorded_at.getTime())[0];
}

/** The item body is withheld; a later disclosure gate can only project addresses and digests. */
function reference(role: string, item: CapturedItem, kind: EvidenceKind = "internal") {
  return capturedReference(role, item, kind);
}

function planPackages(revisions: readonly CapturedRevision[]): Result<RunPackages, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  for (const revision of revisions.filter((candidate) => candidate.artifact_kind === "plan")) {
    const task_revision = revisions.filter((candidate) => candidate.artifact_kind === "tasks"
      && candidate.recorded_at <= revision.recorded_at)
      .sort((a, b) => b.recorded_at.getTime() - a.recorded_at.getTime())[0];
    const tasks = task_revision ? task_revision.items.filter((item) => item.item_kind === "task") : null;
    const decisions = revision.items.filter((item) => item.item_kind === "decision");
    for (const criterion of revision.items.filter((item) => item.item_kind === "criterion")) {
      const eligibility = planCriterionEligibility(criterion, { tasks, plan_decisions: decisions });
      if (!eligibility.ok) return err({ operation: "evidence_packages", entity_id: criterion.occurrence_id, detail: eligibility.error.detail });
      const outcome = eligibility.value;
      if (outcome.kind === "uncited" || outcome.kind === "dangling_citation") {
        exclusions.push({ question_id: "plan.criterion_traceability", occurrence_id: criterion.occurrence_id,
          reason: outcome.kind === "uncited" ? { kind: "uncited" } : { kind: "dangling_citation", evidence_refs: outcome.evidence_refs } });
        continue;
      }
      const cited = outcome.kind === "eligible" ? outcome.tasks : [];
      const references = collectReferences([reference("plan_criterion", criterion),
        ...cited.map((task) => reference("plan_task", task)),
        ...outcome.decisions.map((decision) => reference("plan_decision", decision))]);
      if (!references.ok) return references;
      const evidence = packagedEvidenceSet("plan.criterion_traceability", references.value,
        outcome.kind === "tasks_uncaptured" ? "the run's tasks revision was not captured" : null);
      if (!evidence.ok) return evidence;
      packages.push({ question_id: "plan.criterion_traceability", subject: criterion,
        revision_id: revision.revision_id, evidence: evidence.value });
    }
  }
  return ok({ selection_policy: "live_all_revisions", packages, exclusions, eligibility: [] });
}

function briefPackages(revisions: readonly CapturedRevision[]): Result<RunPackages, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  for (const revision of revisions.filter((candidate) => candidate.artifact_kind === "brief")) {
    const plan = planAtBrief(revisions, revision);
    const plan_criteria = plan?.items.filter((item) => item.item_kind === "criterion") ?? [];
    for (const criterion of revision.items.filter((item) => item.item_kind === "criterion")) {
      const link = criterion.links.find((candidate) => candidate.type === "derived_from"
        && candidate.target_artifact_kind === "plan" && candidate.target_item_kind === "criterion");
      if (!link) {
        exclusions.push({ question_id: "brief.source_fidelity", occurrence_id: criterion.occurrence_id,
          reason: { kind: "unlinked" } });
        continue;
      }
      const source = plan_criteria.find((item) => item.item_scope === link.target_scope
        && item.producer_local_id === link.target_local_id);
      if (!source) {
        exclusions.push({ question_id: "brief.source_fidelity", occurrence_id: criterion.occurrence_id,
          reason: { kind: "dangling_citation", evidence_refs: [link.evidence_ref] } });
        continue;
      }
      const references = collectReferences([reference("plan_criterion", source), reference("brief_criterion", criterion)]);
      if (!references.ok) return references;
      const evidence = packagedEvidenceSet("brief.source_fidelity", references.value, null);
      if (!evidence.ok) return evidence;
      packages.push({ question_id: "brief.source_fidelity", subject: criterion, revision_id: revision.revision_id,
        evidence: evidence.value });
    }
  }
  return ok({ selection_policy: "live_all_revisions", packages, exclusions, eligibility: [] });
}

/** Coverage uses the assessment captured for this brief revision. An empty findings list is valid evidence of a miss. */
function assessmentPackages(revisions: readonly CapturedRevision[]): Result<RunPackages, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  const eligibility: PackageEligibility[] = [];
  const needs_repository = LANGFUSE_PILOT_QUESTIONS["assessment.coverage"].definition.requires_repository_snapshot;
  const briefs = revisions.filter((revision) => revision.artifact_kind === "brief")
    .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime());
  for (const [index, brief] of briefs.entries()) {
    const next_brief = briefs[index + 1];
    const assessments = revisions.filter((revision) => revision.artifact_kind === "assessment"
      && revision.recorded_at >= brief.recorded_at
      && (!next_brief || revision.recorded_at < next_brief.recorded_at))
      .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime());
    for (const criterion of brief.items.filter((item) => item.item_kind === "criterion")) {
      if (needs_repository) {
        eligibility.push({ question_id: "assessment.coverage", occurrence_id: criterion.occurrence_id,
          decision: { tag: "blocked_dependency", payload: { dependency: "ArtifactSource.collect",
            detail: "no repository-content implementor of ArtifactSource.collect exists" } } });
        continue;
      }
      if (assessments.length === 0) {
        exclusions.push({ question_id: "assessment.coverage", occurrence_id: criterion.occurrence_id,
          reason: { kind: "unevidenced" } });
        continue;
      }
      for (const assessment of assessments) {
        const findings = assessment.items.filter((item) => item.item_kind === "assessment_finding"
          && item.links.some((link) => link.type === "assesses" && link.target_artifact_kind === "brief"
            && link.target_item_kind === "criterion" && link.target_scope === criterion.item_scope
            && link.target_local_id === criterion.producer_local_id));
        const references = collectReferences([reference("brief_criterion", criterion),
          ...findings.map((finding) => reference("assessment_finding", finding))]);
        if (!references.ok) return references;
        const evidence = packagedEvidenceSet("assessment.coverage", references.value, null);
        if (!evidence.ok) return evidence;
        packages.push({ question_id: "assessment.coverage", subject: criterion,
          revision_id: assessment.revision_id, evidence: evidence.value });
      }
      const latest = packages.at(-1)!;
      eligibility.push({ question_id: "assessment.coverage", occurrence_id: criterion.occurrence_id,
        decision: { tag: "eligible", payload: { evidence_set_id: latest.evidence.evidence_set_id } } });
    }
  }
  return ok({ selection_policy: "live_all_revisions", packages, exclusions, eligibility });
}

export function runPackages(revisions: readonly CapturedRevision[], policy: RevisionSelection["policy"] = "live_all_revisions")
  : Result<RunPackages, RunPackageError> {
  const selected = selectCapturedRevisions(revisions, policy);
  const plan = planPackages(selected.revisions);
  if (!plan.ok) return plan;
  const brief = briefPackages(selected.revisions);
  if (!brief.ok) return brief;
  const assessment = assessmentPackages(selected.revisions);
  if (!assessment.ok) return assessment;
  const packages = [...plan.value.packages, ...brief.value.packages, ...assessment.value.packages];
  const exclusions = [...plan.value.exclusions, ...brief.value.exclusions, ...assessment.value.exclusions];
  const eligibility: PackageEligibility[] = [
    ...[...plan.value.packages, ...brief.value.packages].map((pack): PackageEligibility => ({ question_id: pack.question_id,
      occurrence_id: pack.subject.occurrence_id,
      decision: { tag: "eligible", payload: { evidence_set_id: pack.evidence.evidence_set_id } } })),
    ...exclusions.map((excluded): PackageEligibility => ({ question_id: excluded.question_id,
      occurrence_id: excluded.occurrence_id,
      decision: excluded.reason.kind === "dangling_citation" || excluded.reason.kind === "unlinked"
        ? { tag: "invalid_reference", payload: excluded.reason }
        : excluded.reason.kind === "skipped_budget" ? { tag: "skipped_budget", payload: excluded.reason }
          : { tag: "missing_evidence", payload: excluded.reason } })),
    ...itemsOf(selected.revisions, "analysis", "finding").map((subject): PackageEligibility => ({
      question_id: "analysis.finding_relevance", occurrence_id: subject.occurrence_id,
      decision: { tag: "missing_evidence", payload: { kind: "missing_source", detail: "no relevant excerpt source is scheduled" } },
    })),
    ...assessment.value.eligibility,
  ];
  return ok({ selection_policy: policy, packages, exclusions, eligibility });
}
