import { canonicalDigest } from "../canonical/canonical-json";
import type { CanonicalDigest, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { err, ok, type Result } from "../domain/primitives";
import type { ExportManifest } from "../export/manifest";
import type { EvidenceSet } from "../grading/evidence";
import { evidenceSetDigest } from "./mapping";

export interface PopulationError { readonly operation: "population_manifest"; readonly entity_id: string; readonly detail: string }
export interface QuestionPin { readonly question_id: QuestionId; readonly question_version: string }
export type PopulationStratum = "clearly_easy" | "borderline" | "known_failure";
export type PopulationDisposition = "included" | "excluded";
/** Exclusions decided by a deterministic check are typed so reports can count them apart. */
export type ExclusionReason =
  | { readonly kind: "uncited" }
  | { readonly kind: "dangling_citation"; readonly evidence_refs: readonly string[] };
export type PopulationReason = { readonly kind: "operator"; readonly detail: string } | ExclusionReason;
export interface SelectedOccurrence extends QuestionPin {
  readonly occurrence_id: ItemOccurrenceId;
  readonly evidence: EvidenceSet;
  readonly stratum: PopulationStratum;
  readonly disposition: PopulationDisposition;
  readonly reason: PopulationReason;
}
export interface PopulationMember extends QuestionPin {
  readonly occurrence_id: ItemOccurrenceId;
  readonly evidence_set_digest: CanonicalDigest;
  readonly stratum: PopulationStratum;
  readonly disposition: PopulationDisposition;
  readonly reason: PopulationReason;
}
export interface ExclusionCount extends QuestionPin {
  readonly operator: number;
  readonly uncited: number;
  readonly dangling_citation: number;
}
export interface PopulationManifest {
  readonly manifest_id: string;
  readonly projection_version: string;
  readonly question_pins: readonly QuestionPin[];
  readonly membership: readonly PopulationMember[];
  /** Digest of the entire sorted selection record, including exclusions and reasons. */
  readonly membership_digest: CanonicalDigest;
  /** Digest of included item/evidence pairs, comparable with assay-jsonl/v1 membership. */
  readonly shared_item_evidence_digest: CanonicalDigest;
}
export interface PopulationSelection {
  readonly manifest_id: string;
  readonly projection_version: string;
  readonly question_pins: readonly QuestionPin[];
  readonly selected: readonly SelectedOccurrence[];
}

function memberOrder(a: PopulationMember, b: PopulationMember): number {
  return a.occurrence_id.localeCompare(b.occurrence_id)
    || a.question_id.localeCompare(b.question_id)
    || a.question_version.localeCompare(b.question_version);
}
function failure(entity_id: string, detail: string): Result<never, PopulationError> {
  return err({ operation: "population_manifest", entity_id, detail });
}
function reasonIssue(selected: SelectedOccurrence): string | null {
  const reason = selected.reason;
  switch (reason.kind) {
    case "operator": return reason.detail.trim() ? null : "inclusion or exclusion reason is required";
    case "uncited": return selected.disposition === "excluded" ? null : "an uncited occurrence must be excluded";
    case "dangling_citation": return selected.disposition !== "excluded" ? "a dangling citation must be excluded"
      : reason.evidence_refs.length > 0 ? null : "a dangling citation names its evidence refs";
  }
}
export function sharedItemEvidenceDigest(membership: readonly Pick<PopulationMember,
  "occurrence_id" | "evidence_set_digest" | "disposition">[]): Result<CanonicalDigest, PopulationError> {
  const pairs = membership.filter((member) => member.disposition === "included")
    .map((member) => ({ occurrence_id: member.occurrence_id, evidence_set_digest: member.evidence_set_digest }))
    .sort((a, b) => a.occurrence_id.localeCompare(b.occurrence_id)
      || a.evidence_set_digest.localeCompare(b.evidence_set_digest));
  const unique = pairs.filter((pair, index) => index === 0 || pair.occurrence_id !== pairs[index - 1]?.occurrence_id
    || pair.evidence_set_digest !== pairs[index - 1]?.evidence_set_digest);
  const digest = canonicalDigest(unique);
  return digest.ok ? digest : failure("membership", digest.error.detail);
}

/** Assay has grade-specific candidate rows; compare the common item/evidence identity. */
export function assayItemEvidenceDigest(manifest: ExportManifest): Result<CanonicalDigest, PopulationError> {
  const included = manifest.membership.filter((member) => member.disposition === "included");
  if (included.some((member) => member.evidence_set_digest === null))
    return failure(manifest.manifest_id, "included Assay member has no evidence digest");
  return sharedItemEvidenceDigest(included.map((member) => ({ occurrence_id: member.occurrence_id,
    evidence_set_digest: member.evidence_set_digest!, disposition: member.disposition })));
}

/** Freeze item-level selection before any grader or external projection runs. */
export function makePopulationManifest(input: PopulationSelection): Result<PopulationManifest, PopulationError> {
  if (!input.manifest_id.trim() || !input.projection_version.trim() || input.question_pins.length === 0)
    return failure(input.manifest_id, "manifest id, projection version and question pins are required");
  const pins = new Set(input.question_pins.map((pin) => `${pin.question_id}\u0000${pin.question_version}`));
  if (pins.size !== input.question_pins.length) return failure(input.manifest_id, "duplicate question pin");
  const membership: PopulationMember[] = [];
  const seen = new Set<string>();
  for (const selected of input.selected) {
    const key = `${selected.occurrence_id}\u0000${selected.question_id}\u0000${selected.question_version}`;
    if (seen.has(key)) return failure(selected.occurrence_id, "duplicate occurrence and question pin");
    seen.add(key);
    if (!pins.has(`${selected.question_id}\u0000${selected.question_version}`))
      return failure(selected.occurrence_id, "question is not pinned");
    const issue = reasonIssue(selected);
    if (issue) return failure(selected.occurrence_id, issue);
    const evidence = evidenceSetDigest(selected.evidence);
    if (!evidence.ok) return failure(selected.occurrence_id, evidence.error.detail);
    membership.push({ occurrence_id: selected.occurrence_id, evidence_set_digest: evidence.value,
      question_id: selected.question_id, question_version: selected.question_version,
      stratum: selected.stratum, disposition: selected.disposition, reason: selected.reason });
  }
  membership.sort(memberOrder);
  const membershipDigest = canonicalDigest(membership);
  if (!membershipDigest.ok) return failure(input.manifest_id, membershipDigest.error.detail);
  const shared = sharedItemEvidenceDigest(membership);
  if (!shared.ok) return shared;
  return ok({ manifest_id: input.manifest_id, projection_version: input.projection_version,
    question_pins: [...input.question_pins].sort((a, b) => a.question_id.localeCompare(b.question_id)
      || a.question_version.localeCompare(b.question_version)), membership,
    membership_digest: membershipDigest.value, shared_item_evidence_digest: shared.value });
}

/** Excluded members per question pin, split by why they left the population. */
export function exclusionCounts(manifest: PopulationManifest): readonly ExclusionCount[] {
  return manifest.question_pins.map((pin) => {
    const excluded = manifest.membership.filter((member) => member.disposition === "excluded"
      && member.question_id === pin.question_id && member.question_version === pin.question_version);
    const count = (kind: PopulationReason["kind"]) => excluded.filter((member) => member.reason.kind === kind).length;
    return { question_id: pin.question_id, question_version: pin.question_version, operator: count("operator"),
      uncited: count("uncited"), dangling_citation: count("dangling_citation") };
  });
}
