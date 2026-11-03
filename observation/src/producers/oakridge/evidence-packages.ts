import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import type { ItemOccurrenceId, QuestionId } from "../../domain/identity";
import type { EvidenceReference, EvidenceSet } from "../../grading/evidence";
import { collectReferences, capturedReference, packagedEvidenceSet, type EvidencePackageError } from "../../grading/evidence-packages/references";
import { selectCapturedRevisions, type CapturedItem, type CapturedRevision, type RevisionSelection } from "../../grading/evidence-packages/capture";
import { planCriterionEligibility } from "./plan-traceability";
import { evidenceKindForCapturedPath } from "./classification";
import { provenanceEligibility, repositorySnapshotEligibility, type EligibilityDecision, type ExclusionReason } from "../../grading/eligibility";
import { hasPinnedPilotRecipe, pinnedPilotRecipe, unsatisfiedSlots, type PilotQuestionId } from "../../grading/evidence-packages/pilot-recipe";
import { hasJudgeRecipe, judgeNeedsRepository, judgeRecipeSchema, type JudgeRecipe } from "../../grading/evidence-packages/judge-recipe";
import { hasCapturedEvidenceRecipe } from "../../grading/evidence-packages/recipe";
import { coverageInput } from "../../runners/coverage-checker";
import type { PilotQuestion } from "../../grading/catalogue/oakridge-questions";
import type { QuestionDefinition } from "../../grading/question";

export type RunQuestionSelection = Readonly<Record<string, PilotQuestion | undefined>>;
type PackageQuestionId = PilotQuestionId | QuestionId;

export interface PilotPackage {
  readonly question_id: PackageQuestionId;
  readonly subject: CapturedItem;
  readonly revision_id: string;
  readonly evidence: EvidenceSet;
}
export interface PackageExclusion {
  readonly question_id: PackageQuestionId;
  readonly occurrence_id: ItemOccurrenceId;
  readonly reason: ExclusionReason;
}
export interface PackageBatch {
  readonly packages: readonly PilotPackage[];
  readonly exclusions: readonly PackageExclusion[];
  readonly eligibility: readonly PackageDecision[];
}
interface PackageDecision {
  readonly question_id: PackageQuestionId;
  readonly occurrence_id: ItemOccurrenceId;
  readonly decision: EligibilityDecision;
}
export interface PackageEligibility extends PackageDecision { readonly question_version: string }
export interface RunPackages extends PackageBatch {
  readonly selection_policy: RevisionSelection["policy"];
  readonly eligibility: readonly PackageEligibility[];
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

/** Capture addresses and digests with classification from the source field's declared sensitivity. */
function reference(role: string, artifact_kind: string, item: CapturedItem, content: JsonValue | null = item.selected_value) {
  const kind = evidenceKindForCapturedPath(artifact_kind, item.path);
  if (!kind.ok) return err({ operation: "evidence_packages" as const, entity_id: item.occurrence_id,
    detail: kind.error.detail });
  return capturedReference(role, item, kind.value, content);
}

function planPackages(revisions: readonly CapturedRevision[], subjects: readonly CapturedRevision[]): Result<PackageBatch, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  for (const revision of subjects) {
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
      const references = collectReferences([reference("plan_criterion", revision.artifact_kind, criterion),
        ...cited.map((task) => reference("plan_task", task_revision?.artifact_kind ?? "tasks", task)),
        ...outcome.decisions.map((decision) => reference("plan_decision", revision.artifact_kind, decision))]);
      if (!references.ok) return references;
      const evidence = packagedEvidenceSet("plan.criterion_traceability", references.value,
        outcome.kind === "tasks_uncaptured" ? "the run's tasks revision was not captured" : null);
      if (!evidence.ok) return evidence;
      packages.push({ question_id: "plan.criterion_traceability", subject: criterion,
        revision_id: revision.revision_id, evidence: evidence.value });
    }
  }
  return ok({ packages, exclusions, eligibility: [] });
}

function briefPackages(revisions: readonly CapturedRevision[], subjects: readonly CapturedRevision[]): Result<PackageBatch, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  for (const revision of subjects) {
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
      const references = collectReferences([reference("plan_criterion", plan?.artifact_kind ?? "plan", source),
        reference("brief_criterion", revision.artifact_kind, criterion)]);
      if (!references.ok) return references;
      const evidence = packagedEvidenceSet("brief.source_fidelity", references.value, null);
      if (!evidence.ok) return evidence;
      packages.push({ question_id: "brief.source_fidelity", subject: criterion, revision_id: revision.revision_id,
        evidence: evidence.value });
    }
  }
  return ok({ packages, exclusions, eligibility: [] });
}

const criterionKey = (scope: string | null, local_id: string | null): string => `${scope}\u0000${local_id}`;

/** Every brief criterion an assessment's findings explicitly assess. */
function assessedCriterionKeys(assessment: CapturedRevision): ReadonlySet<string> {
  return new Set(assessment.items.flatMap((item) => item.links
    .filter((link) => link.type === "assesses" && link.target_artifact_kind === "brief"
      && link.target_item_kind === "criterion")
    .map((link) => criterionKey(link.target_scope, link.target_local_id))));
}

/** A brief and its assessment sit in different units — `briefs/<cohort>` against
 * `implementation/<cohort>` — and no captured revision links them structurally. Criterion
 * identity is flat and run-unique, so an `assesses` link names exactly one brief revision's
 * criterion and is the reliable key. An assessment that assesses no captured brief criterion
 * at all cannot be placed that way; it is attributed by capture time, which is what lets a
 * findings-free assessment still answer coverage negatively. */
function assessmentCoversBrief(assessment: CapturedRevision, brief: CapturedRevision): boolean {
  const assessed = assessedCriterionKeys(assessment);
  if (assessed.size === 0) return true;
  return brief.items.some((item) => item.item_kind === "criterion"
    && assessed.has(criterionKey(item.item_scope, item.producer_local_id)));
}

/** Coverage uses the assessment captured for this brief revision. An empty findings list is valid evidence of a miss. */
interface AssessmentSources { readonly revisions: readonly CapturedRevision[]; readonly subjects: readonly CapturedRevision[];
}
function assessmentPackages({ revisions, subjects }: AssessmentSources): Result<PackageBatch, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  const eligibility: PackageDecision[] = [];
  const supported_ids = new Set(subjects.map((revision) => revision.revision_id));
  const briefs = revisions.filter((revision) => revision.artifact_kind === "brief")
    .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime());
  for (const [index, brief] of briefs.entries()) {
    if (!supported_ids.has(brief.revision_id)) continue;
    // A concurrent cohort's brief must not close this one's assessment window: a run can
    // capture brief A, brief B, then A's assessment. Only a later revision of the same unit
    // supersedes this brief, including a successor whose provenance is unsupported.
    const next_brief = briefs.slice(index + 1).find((candidate) => candidate.unit_id === brief.unit_id);
    const assessments = revisions.filter((revision) => revision.artifact_kind === "assessment"
      && assessmentCoversBrief(revision, brief)
      && revision.recorded_at >= brief.recorded_at
      && (!next_brief || revision.recorded_at < next_brief.recorded_at))
      .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime());
    for (const criterion of brief.items.filter((item) => item.item_kind === "criterion")) {
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
        const links = coverageInput(criterion, findings);
        if (!links.ok) return err({ operation: "evidence_packages", entity_id: criterion.occurrence_id, detail: links.error.detail });
        const references = collectReferences([reference("brief_criterion", brief.artifact_kind, criterion,
          links.value as unknown as JsonValue),
          ...findings.map((finding) => reference("assessment_finding", assessment.artifact_kind, finding))]);
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
  return ok({ packages, exclusions, eligibility });
}

interface SubjectSelection {
  readonly revisions: readonly CapturedRevision[];
  readonly eligibility: readonly PackageDecision[];
}
const subjectArtifactKinds: Readonly<Record<PilotQuestionId, string>> = {
  "analysis.finding_relevance": "analysis", "plan.criterion_traceability": "plan",
  "brief.source_fidelity": "brief", "assessment.coverage": "brief",
};
export function pilotSubjectArtifactKind(question_id: string): string | null {
  return Object.hasOwn(subjectArtifactKinds, question_id) ? subjectArtifactKinds[question_id as PilotQuestionId] : null;
}
function selectSubjects(revisions: readonly CapturedRevision[], question: PilotQuestion | undefined): SubjectSelection {
  if (!question) return { revisions: [], eligibility: [] };
  const question_id = question.definition.question_id as PilotQuestionId;
  const candidates = revisions.filter((revision) => revision.artifact_kind === subjectArtifactKinds[question_id]);
  const decisions = candidates.map((revision) => ({ revision,
    decision: provenanceEligibility(question.definition.pinned_expectation, revision) }));
  return {
    revisions: decisions.filter(({ decision }) => decision.tag === "eligible").map(({ revision }) => revision),
    eligibility: decisions.flatMap(({ revision, decision }) => decision.tag === "inapplicable"
      ? revision.items.filter((item) => question.definition.target_item_kinds.includes(item.item_kind))
        .map((item) => ({ question_id, occurrence_id: item.occurrence_id, decision })) : []),
  };
}

interface JudgeSources {
  readonly revisions: readonly CapturedRevision[];
  readonly question: QuestionDefinition;
  readonly recipe: JudgeRecipe;
  readonly repository_sources: ReadonlyMap<ItemOccurrenceId, EvidenceSet>;
}

/** Judge allowlists name exact captured addresses, never request-body evidence or similar prose. */
function judgePackages({ revisions, question, recipe, repository_sources }: JudgeSources): Result<PackageBatch, RunPackageError> {
  const packages: PilotPackage[] = [];
  const eligibility: PackageDecision[] = [];
  const available: EvidenceReference[] = [];
  for (const revision of revisions) for (const item of revision.items) {
    const ref = reference(item.item_kind, revision.artifact_kind, item);
    if (!ref.ok) return ref;
    available.push({ ...ref.value, ref: ref.value.deep_link! });
  }
  for (const evidence of repository_sources.values()) for (const ref of evidence.references) {
    if (ref.deep_link && ref.kind === "repository_content") available.push({ ...ref, kind: ref.kind, ref: ref.deep_link });
  }
  for (const revision of revisions) for (const subject of revision.items.filter((item) => question.target_item_kinds.includes(item.item_kind))) {
    const provenance = provenanceEligibility(question.pinned_expectation, revision);
    if (provenance.tag !== "eligible") {
      eligibility.push({ question_id: question.question_id, occurrence_id: subject.occurrence_id, decision: provenance });
      continue;
    }
    const references = recipe.judge.evidence_refs.map((address) => available.find((ref) => ref.ref === address));
    const absent = recipe.judge.evidence_refs.find((_address, index) => !references[index]);
    const subject_address = `oakridge://revision/${encodeURIComponent(subject.revision_id)}#${subject.path}`;
    const selects_subject = recipe.judge.evidence_refs.includes(subject_address)
      || (recipe.judge.target === "code" && (repository_sources.get(subject.occurrence_id)?.references ?? [])
        .some((ref) => ref.deep_link && recipe.judge.evidence_refs.includes(ref.deep_link)));
    if (absent || !selects_subject) {
      eligibility.push({ question_id: question.question_id, occurrence_id: subject.occurrence_id,
        decision: { tag: "missing_evidence", payload: { kind: "missing_source", detail: absent
          ? `judge evidence reference is absent from captured run: ${absent}` : "judge allowlist does not select this captured subject" } } });
      continue;
    }
    const evidence = packagedEvidenceSet(question.question_id, references as EvidenceReference[], null);
    if (!evidence.ok) return evidence;
    packages.push({ question_id: question.question_id, subject, revision_id: revision.revision_id, evidence: evidence.value });
    eligibility.push({ question_id: question.question_id, occurrence_id: subject.occurrence_id,
      decision: { tag: "eligible", payload: { evidence_set_id: evidence.value.evidence_set_id } } });
  }
  return ok({ packages, exclusions: [], eligibility });
}

export function runPackages(revisions: readonly CapturedRevision[], questions: RunQuestionSelection, policy: RevisionSelection["policy"] = "live_all_revisions",
  repository_sources: ReadonlyMap<ItemOccurrenceId, EvidenceSet> = new Map())
  : Result<RunPackages, RunPackageError> {
  for (const [question_id, question] of Object.entries(questions)) {
    if (!question) continue;
    if (question_id !== question.definition.question_id
      || !hasCapturedEvidenceRecipe(question.definition))
      return err({ operation: "evidence_packages", entity_id: question_id, detail: "question has no supported captured evidence recipe" });
  }
  const selected = selectCapturedRevisions(revisions, policy);
  const pilot = (id: PilotQuestionId) => {
    const question = questions[id];
    return question && hasPinnedPilotRecipe(question.definition) ? question : undefined;
  };
  const analysis_subjects = selectSubjects(selected.revisions, pilot("analysis.finding_relevance"));
  const plan_subjects = selectSubjects(selected.revisions, pilot("plan.criterion_traceability"));
  const brief_subjects = selectSubjects(selected.revisions, pilot("brief.source_fidelity"));
  const coverage_subjects = selectSubjects(selected.revisions, pilot("assessment.coverage"));
  const plan = planPackages(selected.revisions, plan_subjects.revisions);
  if (!plan.ok) return plan;
  const brief = briefPackages(selected.revisions, brief_subjects.revisions);
  if (!brief.ok) return brief;
  const assessment = assessmentPackages({ revisions: selected.revisions, subjects: coverage_subjects.revisions });
  if (!assessment.ok) return assessment;
  // A built package must satisfy the slot counts its question pins. The builders construct
  // references from their own rules and never see the pin, so without this a pin requiring two
  // plan_decision references is marked eligible against a capture holding one.
  const slotShortfall = (pack: PilotPackage): readonly string[] => {
    const question = questions[pack.question_id];
    const recipe = question ? pinnedPilotRecipe(question.definition) : null;
    return recipe ? unsatisfiedSlots(recipe, pack.evidence.references) : [];
  };
  const built = [...plan.value.packages, ...brief.value.packages];
  const satisfied = built.filter((pack) => slotShortfall(pack).length === 0);
  const underEvidenced = built.filter((pack) => slotShortfall(pack).length > 0);
  let packages = [...satisfied, ...assessment.value.packages];
  const exclusions = [...plan.value.exclusions, ...brief.value.exclusions, ...assessment.value.exclusions];
  const eligibility: PackageDecision[] = [
    ...[analysis_subjects, plan_subjects, brief_subjects, coverage_subjects].flatMap((selection) => selection.eligibility),
    ...satisfied.map((pack): PackageDecision => ({ question_id: pack.question_id,
      occurrence_id: pack.subject.occurrence_id,
      decision: { tag: "eligible", payload: { evidence_set_id: pack.evidence.evidence_set_id } } })),
    ...underEvidenced.map((pack): PackageDecision => ({ question_id: pack.question_id,
      occurrence_id: pack.subject.occurrence_id,
      decision: { tag: "missing_evidence", payload: { kind: "missing_source",
        detail: `pinned recipe is unsatisfied for ${slotShortfall(pack).join(", ")}` } } })),
    ...exclusions.map((excluded): PackageDecision => ({ question_id: excluded.question_id,
      occurrence_id: excluded.occurrence_id,
      decision: excluded.reason.kind === "dangling_citation" || excluded.reason.kind === "unlinked"
        ? { tag: "invalid_reference", payload: excluded.reason }
        : excluded.reason.kind === "skipped_budget" ? { tag: "skipped_budget", payload: excluded.reason }
          : { tag: "missing_evidence", payload: excluded.reason } })),
    ...itemsOf(analysis_subjects.revisions, "analysis", "finding").map((subject): PackageDecision => ({
      question_id: "analysis.finding_relevance", occurrence_id: subject.occurrence_id,
      decision: { tag: "missing_evidence", payload: { kind: "missing_source", detail: "no relevant excerpt source is scheduled" } },
    })),
    ...assessment.value.eligibility,
  ];
  for (const question of Object.values(questions)) {
    if (!question) continue;
    const recipe = judgeRecipeSchema.safeParse(question.definition.input_recipe);
    if (!recipe.success) continue;
    const judged = judgePackages({ revisions: selected.revisions, question: question.definition, recipe: recipe.data, repository_sources });
    if (!judged.ok) return judged;
    packages.push(...judged.value.packages);
    eligibility.push(...judged.value.eligibility);
  }
  const source_items = selected.revisions.flatMap((revision) => revision.items);
  const enriched: PilotPackage[] = [];
  for (const pack of packages) {
    const question = questions[pack.question_id]?.definition;
    if (!question || (!question.requires_repository_snapshot && !judgeNeedsRepository(question))) { enriched.push(pack); continue; }
    const sources = source_items.filter((item) => pack.evidence.references.some((ref) =>
      ref.deep_link === `oakridge://revision/${encodeURIComponent(item.revision_id)}#${item.path}`))
      .flatMap((item) => repository_sources.get(item.occurrence_id)?.references ?? []);
    const evidence = packagedEvidenceSet(pack.question_id,
      (hasJudgeRecipe(question) ? pack.evidence.references : [...pack.evidence.references, ...sources]) as EvidenceReference[],
      pack.evidence.incompleteness_reason);
    if (!evidence.ok) return evidence;
    const source_revision = selected.revisions.find((revision) => revision.revision_id === pack.revision_id);
    const decision = repositorySnapshotEligibility(evidence.value,
      Number(question.input_recipe.minimum_repository_content ?? 1), source_revision?.reviewed_commit ?? "");
    const index = eligibility.findIndex((item) => item.question_id === pack.question_id
      && item.occurrence_id === pack.subject.occurrence_id);
    if (index >= 0) eligibility[index] = { question_id: pack.question_id, occurrence_id: pack.subject.occurrence_id, decision };
    if (decision.tag === "eligible") enriched.push({ ...pack, evidence: evidence.value });
  }
  packages = enriched;
  return ok({ selection_policy: policy, packages, exclusions, eligibility: eligibility.map((item) => ({ ...item,
    question_version: questions[item.question_id]!.definition.question_version })) });
}
