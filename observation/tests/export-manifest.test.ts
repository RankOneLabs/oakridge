import { expect, test } from "bun:test";
import { makeManifest, membershipDigest, type ExportMembership, type ExportManifest } from "../src/export/manifest";
import type { ArtifactRevisionId, CanonicalDigest, GradeObservationId, ItemOccurrenceId, EvidenceSetId } from "../src/domain/identity";

const member: ExportMembership = {
  candidate_id: "canonical-json/v1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as CanonicalDigest,
  occurrence_id: "occurrence-1" as ItemOccurrenceId,
  revision_id: "revision-1" as ArtifactRevisionId,
  revision_digest: "canonical-json/v1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as CanonicalDigest,
  evidence_set_id: "evidence-1" as EvidenceSetId,
  evidence_set_digest: "canonical-json/v1:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc" as CanonicalDigest,
  observation_id: "grade-1" as GradeObservationId,
  disposition: "included", reason: "selected_complete_grade", redaction_reasons: [],
};
const base: Omit<ExportManifest, "membership_digest"> = {
  producer: "oakridge", namespace: "test", manifest_id: "manifest-1", frozen_at: "2026-01-01T00:00:00.000Z",
  format_version: "assay-jsonl/v1", redaction_policy: {
    allow_raw_build_output: false, allow_raw_test_output: false, allow_repository_content: false,
  }, file_hashes: { "candidates.jsonl": "sha256:abc" }, membership: [member],
};

test("identical frozen inputs produce identical canonical membership digest", () => {
  const first = makeManifest(base); const second = makeManifest({ ...base, manifest_id: "manifest-2", frozen_at: "2026-02-01T00:00:00.000Z" });
  expect(first.ok && second.ok && first.value.membership_digest).toBe(second.ok && second.value.membership_digest);
});

test("later grade candidates cannot change frozen membership or digest", () => {
  const frozen = makeManifest(base);
  if (!frozen.ok) throw new Error(frozen.error.detail);
  const later: ExportMembership = { ...member, candidate_id: "canonical-json/v1:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd" as CanonicalDigest,
    observation_id: "grade-2" as GradeObservationId };
  const fresh = makeManifest({ ...base, membership: [member, later], manifest_id: "manifest-2" });
  expect(frozen.value.membership).toEqual([member]);
  expect(membershipDigest(frozen.value.membership)).toEqual({ ok: true, value: frozen.value.membership_digest });
  expect(fresh.ok && fresh.value.membership_digest).not.toBe(frozen.value.membership_digest);
});
