import { canonicalDigest } from "canonical-json";
import { err, ok, type JsonValue, type Result } from "../../domain/primitives";
import type { ItemOccurrenceId, QuestionId } from "../../domain/identity";
import type { EvidenceReference, EvidenceSet } from "../../grading/evidence";
import { collectReferences, capturedReference, packagedEvidenceSet, type EvidencePackageError } from "../../grading/evidence-packages/references";
import { declaredLinks, linkedItems, selectCapturedRevisions, type CapturedItem, type CapturedRevision, type RevisionSelection } from "../../grading/evidence-packages/capture";
import { evidenceKindForCapturedPath } from "./classification";
import { schemaProvenanceEligibility, provenanceEligibility, repositorySnapshotEligibility, type EligibilityDecision, type ExclusionReason } from "../../grading/eligibility";
import { pinnedPilotRecipe, recipeSlots, unsatisfiedSlots, type EvidenceBuild, type EvidenceSlot,
  type PilotEvidenceRecipe, type SlotSource, type SubjectBinding } from "../../grading/evidence-packages/pilot-recipe";
import { hasJudgeRecipe, judgeRecipeSchema, type JudgeRecipe } from "../../grading/evidence-packages/judge-recipe";
import { hasCapturedEvidenceRecipe, pinnedRepositoryMinimum, requiresRepositorySnapshot } from "../../grading/evidence-packages/recipe";
import { coverageInput, type CoverageInput } from "../../runners/coverage-checker";
import type { PilotQuestion } from "../../grading/catalogue/oakridge-questions";
import type { QuestionDefinition } from "../../grading/question";

export type RunQuestionSelection = Readonly<Record<string, PilotQuestion | undefined>>;
type PackageQuestionId = QuestionId;

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

/** Capture addresses and digests with classification from the source field's declared sensitivity. */
function reference(role: string, artifact_kind: string, item: CapturedItem, content: JsonValue | null = item.selected_value) {
  const kind = evidenceKindForCapturedPath(artifact_kind, item.path);
  if (!kind.ok) return err({ operation: "evidence_packages" as const, entity_id: item.occurrence_id,
    detail: kind.error.detail });
  return capturedReference(role, item, kind.value, content);
}

type LinkRelation = Extract<SlotSource, { from: "linked" }>;

interface BuilderInput {
  readonly revisions: readonly CapturedRevision[];
  /** Revisions whose provenance matches the pin; the only ones a decision is derived for. */
  readonly subjects: readonly CapturedRevision[];
  readonly question: QuestionDefinition;
  readonly recipe: PilotEvidenceRecipe;
}

function slotsFrom(slots: readonly EvidenceSlot[], from: SlotSource["from"]): readonly EvidenceSlot[] {
  return slots.filter((slot) => slot.source.from === from);
}

/** The revision a linked slot resolves against: the subject's own when the relation names its
 * artifact kind, otherwise the newest revision of that kind captured at or before it. A plan
 * cites the tasks that existed when it was written, not a later revision of them. */
function slotPool(revisions: readonly CapturedRevision[], host: CapturedRevision, relation: LinkRelation)
  : CapturedRevision | undefined {
  if (relation.artifact_kind === host.artifact_kind) return host;
  return revisions.filter((candidate) => candidate.artifact_kind === relation.artifact_kind
    && candidate.recorded_at <= host.recorded_at)
    .sort((a, b) => b.recorded_at.getTime() - a.recorded_at.getTime())[0];
}

/** Walk every relation the pin declares and package each subject with what resolves. References
 * come out in pinned slot order — input slots then output slots — so the package shape is the
 * recipe's, not a builder's. The two failures slots cannot name are classified by the build: a
 * subject declaring no link at all, and a source revision the run never captured. */
function linkedSourcePackages({ revisions, subjects, question, recipe }: BuilderInput,
  build: Extract<EvidenceBuild, { kind: "linked_sources" }>): Result<PackageBatch, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  const question_id = question.question_id;
  const slots = recipeSlots(recipe);
  for (const host of subjects) {
    for (const subject of host.items.filter((item) => item.item_kind === recipe.subject.item_kind)) {
      const refs = new Map<number, readonly Result<EvidenceReference, EvidencePackageError>[]>();
      const dangling: string[] = [];
      const uncaptured: string[] = [];
      let declared = 0;
      for (const [index, slot] of slots.entries()) {
        if (slot.source.from === "subject") {
          refs.set(index, [reference(slot.role, host.artifact_kind, subject)]);
          continue;
        }
        if (slot.source.from === "unscheduled") continue;
        const relation = slot.source;
        // The pin schema refuses an inward relation for this build, so every relation here is
        // declared by the subject's own links and resolved against a backward-looking pool.
        const links = declaredLinks(subject, relation);
        declared += links.length;
        const pool = slotPool(revisions, host, relation);
        if (!pool) {
          if (links.length === 0) continue;
          if (build.uncaptured_source === "dangling") dangling.push(...links.map((link) => link.evidence_ref));
          else uncaptured.push(relation.artifact_kind);
          continue;
        }
        const walk = linkedItems(subject, relation, recipe.subject, pool.items);
        dangling.push(...walk.dangling);
        refs.set(index, walk.resolved.map((item) => reference(slot.role, pool.artifact_kind, item)));
      }
      if (declared === 0) {
        exclusions.push({ question_id, occurrence_id: subject.occurrence_id,
          reason: build.undeclared === "uncited" ? { kind: "uncited" } : { kind: "unlinked" } });
        continue;
      }
      if (dangling.length > 0) {
        exclusions.push({ question_id, occurrence_id: subject.occurrence_id,
          reason: { kind: "dangling_citation", evidence_refs: dangling } });
        continue;
      }
      const references = collectReferences(slots.flatMap((_, index) => refs.get(index) ?? []));
      if (!references.ok) return references;
      const evidence = packagedEvidenceSet(question_id, references.value,
        uncaptured.length > 0 ? `the run's ${uncaptured[0]} revision was not captured` : null);
      if (!evidence.ok) return evidence;
      packages.push({ question_id, subject, revision_id: host.revision_id, evidence: evidence.value });
    }
  }
  return ok({ packages, exclusions, eligibility: [] });
}

const subjectKey = (scope: string | null, local_id: string | null): string => `${scope}\u0000${local_id}`;

/** Every subject item a source revision's items explicitly point at through the pinned relation. */
function linkedSubjectKeys(source: CapturedRevision, relation: LinkRelation, binding: SubjectBinding): ReadonlySet<string> {
  return new Set(source.items.flatMap((item) => item.links
    .filter((link) => link.type === relation.link_type && link.target_artifact_kind === binding.artifact_kind
      && link.target_item_kind === binding.item_kind)
    .map((link) => subjectKey(link.target_scope, link.target_local_id))));
}

/** A brief and its assessment sit in different units — `briefs/<cohort>` against
 * `implementation/<cohort>` — and no captured revision links them structurally. Criterion
 * identity is flat and run-unique, so an `assesses` link names exactly one brief revision's
 * criterion and is the reliable key. A source that points at no captured subject at all cannot
 * be placed that way; it is attributed by capture time, which is what lets a findings-free
 * assessment still answer coverage negatively. */
function sourceCoversSubjects(source: CapturedRevision, host: CapturedRevision, relation: LinkRelation,
  binding: SubjectBinding): boolean {
  const linked = linkedSubjectKeys(source, relation, binding);
  if (linked.size === 0) return true;
  return host.items.some((item) => item.item_kind === binding.item_kind
    && linked.has(subjectKey(item.item_scope, item.producer_local_id)));
}

/** The derived link view has its own digest. Captured source references follow it
 * in the package; a source deep link must never claim to resolve this view. */
function coverageLinkReference(subject: CapturedItem, links: CoverageInput): Result<EvidenceReference, EvidencePackageError> {
  const digest = canonicalDigest(links);
  if (!digest.ok) return err({ operation: "evidence_packages", entity_id: subject.occurrence_id,
    detail: digest.error.detail });
  return ok({ ref: `coverage_links:${subject.occurrence_id}`, kind: "internal",
    content: links as unknown as JsonValue, digest: digest.value });
}

/** The pinned relation points inward, so the source revision is found by capture window rather
 * than by a link on the subject. An empty resolved set is valid evidence of a miss. */
function assessmentWindowPackages({ revisions, subjects, question, recipe }: BuilderInput)
  : Result<PackageBatch, RunPackageError> {
  const packages: PilotPackage[] = [];
  const exclusions: PackageExclusion[] = [];
  const eligibility: PackageDecision[] = [];
  const question_id = question.question_id;
  const inward = recipeSlots(recipe).flatMap((slot) => slot.source.from === "linked" && slot.source.direction === "in"
    ? [{ role: slot.role, relation: slot.source }] : []);
  if (inward.length !== 1) return err({ operation: "evidence_packages", entity_id: question_id,
    detail: "an assessment window recipe pins exactly one inward relation" });
  const { role, relation } = inward[0]!;
  const own = slotsFrom(recipeSlots(recipe), "subject");
  const supported = new Set(subjects.map((revision) => revision.revision_id));
  const hosts = revisions.filter((revision) => revision.artifact_kind === recipe.subject.artifact_kind)
    .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime());
  for (const [index, host] of hosts.entries()) {
    if (!supported.has(host.revision_id)) continue;
    // A concurrent cohort's brief must not close this one's assessment window: a run can
    // capture brief A, brief B, then A's assessment. Only a later revision of the same unit
    // supersedes this host, including a successor whose provenance is unsupported.
    const successor = hosts.slice(index + 1).find((candidate) => candidate.unit_id === host.unit_id);
    const sources = revisions.filter((revision) => revision.artifact_kind === relation.artifact_kind
      && sourceCoversSubjects(revision, host, relation, recipe.subject)
      && revision.recorded_at >= host.recorded_at
      && (!successor || revision.recorded_at < successor.recorded_at))
      .sort((a, b) => a.recorded_at.getTime() - b.recorded_at.getTime());
    for (const subject of host.items.filter((item) => item.item_kind === recipe.subject.item_kind)) {
      if (sources.length === 0) {
        exclusions.push({ question_id, occurrence_id: subject.occurrence_id, reason: { kind: "unevidenced" } });
        continue;
      }
      for (const source of sources) {
        const found = linkedItems(subject, relation, recipe.subject, source.items).resolved;
        const links = coverageInput(subject, found);
        if (!links.ok) return err({ operation: "evidence_packages", entity_id: subject.occurrence_id,
          detail: links.error.detail });
        const references = collectReferences([
          coverageLinkReference(subject, links.value),
          ...own.map((slot) => reference(slot.role, host.artifact_kind, subject)),
          ...found.map((item) => reference(role, source.artifact_kind, item)),
        ]);
        if (!references.ok) return references;
        const evidence = packagedEvidenceSet(question_id, references.value, null);
        if (!evidence.ok) return evidence;
        packages.push({ question_id, subject, revision_id: source.revision_id, evidence: evidence.value });
      }
      const latest = packages.at(-1)!;
      eligibility.push({ question_id, occurrence_id: subject.occurrence_id,
        decision: { tag: "eligible", payload: { evidence_set_id: latest.evidence.evidence_set_id } } });
    }
  }
  return ok({ packages, exclusions, eligibility });
}

/** No captured artifact supplies this question's inputs, so every subject is excluded for a
 * missing source. The pin says which, instead of a branch keyed on the question id. */
function unscheduledSourcePackages({ subjects, question, recipe }: BuilderInput,
  build: Extract<EvidenceBuild, { kind: "unscheduled_source" }>): PackageBatch {
  return { packages: [], exclusions: [], eligibility: subjects.flatMap((revision) =>
    revision.items.filter((item) => item.item_kind === recipe.subject.item_kind).map((subject) => ({
      question_id: question.question_id, occurrence_id: subject.occurrence_id,
      decision: { tag: "missing_evidence" as const, payload: { kind: "missing_source" as const, detail: build.detail } },
    }))) };
}

interface SubjectSelection {
  readonly revisions: readonly CapturedRevision[];
  readonly eligibility: readonly PackageDecision[];
}
/** Revisions whose recorded provenance matches the pin, and an inapplicable decision for every
 * targeted item in the ones that do not. The subject's artifact kind comes from the pin. */
function selectSubjects(revisions: readonly CapturedRevision[], question: QuestionDefinition,
  recipe: PilotEvidenceRecipe, provenance_policy: "legacy" | "schema"): SubjectSelection {
  const candidates = revisions.filter((revision) => revision.artifact_kind === recipe.subject.artifact_kind);
  const decisions = candidates.map((revision) => ({ revision,
    decision: (provenance_policy === "schema" ? schemaProvenanceEligibility : provenanceEligibility)(question.pinned_expectation, revision) }));
  return {
    revisions: decisions.filter(({ decision }) => decision.tag === "eligible").map(({ revision }) => revision),
    eligibility: decisions.flatMap(({ revision, decision }) => decision.tag === "inapplicable"
      ? revision.items.filter((item) => question.target_item_kinds.includes(item.item_kind))
        .map((item) => ({ question_id: question.question_id, occurrence_id: item.occurrence_id, decision })) : []),
  };
}

interface JudgeSources {
  readonly revisions: readonly CapturedRevision[];
  readonly question: QuestionDefinition;
  readonly recipe: JudgeRecipe;
  readonly repository_sources: ReadonlyMap<ItemOccurrenceId, EvidenceSet>;
  readonly provenance_policy: "legacy" | "schema";
}

/** Judge allowlists name exact captured addresses, never request-body evidence or similar prose. */
function judgePackages({ revisions, question, recipe, repository_sources, provenance_policy }: JudgeSources): Result<PackageBatch, RunPackageError> {
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
    const provenance = (provenance_policy === "schema" ? schemaProvenanceEligibility : provenanceEligibility)(question.pinned_expectation, revision);
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
  repository_sources: ReadonlyMap<ItemOccurrenceId, EvidenceSet> = new Map(), provenance_policy: "legacy" | "schema" = "legacy")
  : Result<RunPackages, RunPackageError> {
  for (const [question_id, question] of Object.entries(questions)) {
    if (!question) continue;
    if (question_id !== question.definition.question_id
      || !hasCapturedEvidenceRecipe(question.definition))
      return err({ operation: "evidence_packages", entity_id: question_id, detail: "question has no supported captured evidence recipe" });
  }
  const selected = selectCapturedRevisions(revisions, policy);
  // Dispatch on the build the question pins, never on its id. Two questions may pin the same
  // build and subject binding; each still carries its own id through to its own decisions.
  const batches: PackageBatch[] = [];
  for (const question of Object.values(questions)) {
    if (!question) continue;
    const recipe = pinnedPilotRecipe(question.definition);
    if (!recipe) continue;
    const selection = selectSubjects(selected.revisions, question.definition, recipe, provenance_policy);
    const input: BuilderInput = { revisions: selected.revisions, subjects: selection.revisions,
      question: question.definition, recipe };
    const built = recipe.build.kind === "linked_sources" ? linkedSourcePackages(input, recipe.build)
      : recipe.build.kind === "assessment_window" ? assessmentWindowPackages(input)
        : ok(unscheduledSourcePackages(input, recipe.build));
    if (!built.ok) return built;
    batches.push({ ...built.value, eligibility: [...selection.eligibility, ...built.value.eligibility] });
  }
  // A built package must satisfy the slot counts its question pins. The builders construct
  // references from the pinned relations but do not enforce the counts, so without this a pin
  // requiring two plan_decision references is marked eligible against a capture holding one.
  const slotShortfall = (pack: PilotPackage): readonly string[] => {
    const question = questions[pack.question_id];
    const recipe = question ? pinnedPilotRecipe(question.definition) : null;
    return recipe ? unsatisfiedSlots(recipe, pack.evidence.references) : [];
  };
  const built = batches.flatMap((batch) => batch.packages);
  const satisfied = built.filter((pack) => slotShortfall(pack).length === 0);
  const underEvidenced = built.filter((pack) => slotShortfall(pack).length > 0);
  const shortfallOf = new Map(underEvidenced.map((pack) => [String(pack.evidence.evidence_set_id), pack]));
  const unsatisfiedDecision = (pack: PilotPackage): EligibilityDecision => ({ tag: "missing_evidence",
    payload: { kind: "missing_source", detail: `pinned recipe is unsatisfied for ${slotShortfall(pack).join(", ")}` } });
  // A subject whose pinned decision is a slot shortfall has no admissible package. The window
  // builder emits one package per source revision, so without this an earlier satisfied package
  // survives and the repository pass below overwrites the shortfall decision from it.
  const shortSubjects = new Set(underEvidenced.map((pack) => `${pack.question_id} ${pack.subject.occurrence_id}`));
  const admissible = satisfied.filter((pack) => !shortSubjects.has(`${pack.question_id} ${pack.subject.occurrence_id}`));
  let packages = [...admissible];
  const exclusions = batches.flatMap((batch) => batch.exclusions);
  // A builder that names its own eligible evidence set — the assessment window picks the latest
  // in the window — must not keep that decision when the package it names failed the slot check.
  const fromBuilders = batches.flatMap((batch) => batch.eligibility).map((item) => {
    if (item.decision.tag !== "eligible") return item;
    const dropped = shortfallOf.get(String(item.decision.payload.evidence_set_id));
    return dropped ? { ...item, decision: unsatisfiedDecision(dropped) } : item;
  });
  const decided = new Set(fromBuilders.map((item) => `${item.question_id} ${item.occurrence_id}`));
  const undecided = (pack: PilotPackage) => !decided.has(`${pack.question_id} ${pack.subject.occurrence_id}`);
  const eligibility: PackageDecision[] = [
    ...fromBuilders,
    ...admissible.filter(undecided).map((pack): PackageDecision => ({ question_id: pack.question_id,
      occurrence_id: pack.subject.occurrence_id,
      decision: { tag: "eligible", payload: { evidence_set_id: pack.evidence.evidence_set_id } } })),
    ...underEvidenced.filter(undecided).map((pack): PackageDecision => ({ question_id: pack.question_id,
      occurrence_id: pack.subject.occurrence_id, decision: unsatisfiedDecision(pack) })),
    ...exclusions.map((excluded): PackageDecision => ({ question_id: excluded.question_id,
      occurrence_id: excluded.occurrence_id,
      decision: excluded.reason.kind === "dangling_citation" || excluded.reason.kind === "unlinked"
        ? { tag: "invalid_reference", payload: excluded.reason }
        : excluded.reason.kind === "skipped_budget" ? { tag: "skipped_budget", payload: excluded.reason }
          : { tag: "missing_evidence", payload: excluded.reason } })),
  ];
  for (const question of Object.values(questions)) {
    if (!question) continue;
    const recipe = judgeRecipeSchema.safeParse(question.definition.input_recipe);
    if (!recipe.success) continue;
    const judged = judgePackages({ revisions: selected.revisions, question: question.definition, recipe: recipe.data, repository_sources, provenance_policy });
    if (!judged.ok) return judged;
    packages.push(...judged.value.packages);
    eligibility.push(...judged.value.eligibility);
  }
  const source_items = selected.revisions.flatMap((revision) => revision.items);
  const enriched: PilotPackage[] = [];
  for (const pack of packages) {
    const question = questions[pack.question_id]?.definition;
    if (!question || !requiresRepositorySnapshot(question)) { enriched.push(pack); continue; }
    const sources = source_items.filter((item) => pack.evidence.references.some((ref) =>
      ref.deep_link === `oakridge://revision/${encodeURIComponent(item.revision_id)}#${item.path}`))
      .flatMap((item) => repository_sources.get(item.occurrence_id)?.references ?? []);
    const evidence = packagedEvidenceSet(pack.question_id,
      (hasJudgeRecipe(question) ? pack.evidence.references : [...pack.evidence.references, ...sources]) as EvidenceReference[],
      pack.evidence.incompleteness_reason);
    if (!evidence.ok) return evidence;
    const source_revision = selected.revisions.find((revision) => revision.revision_id === pack.revision_id);
    const minimum = pinnedRepositoryMinimum(question);
    if (!minimum.ok) return minimum;
    const decision = repositorySnapshotEligibility(evidence.value, minimum.value,
      source_revision?.reviewed_commit ?? "");
    const index = eligibility.findIndex((item) => item.question_id === pack.question_id
      && item.occurrence_id === pack.subject.occurrence_id);
    if (index >= 0) eligibility[index] = { question_id: pack.question_id, occurrence_id: pack.subject.occurrence_id, decision };
    if (decision.tag === "eligible") enriched.push({ ...pack, evidence: evidence.value });
  }
  packages = enriched;
  return ok({ selection_policy: policy, packages, exclusions, eligibility: eligibility.map((item) => ({ ...item,
    question_version: questions[item.question_id]!.definition.question_version })) });
}
