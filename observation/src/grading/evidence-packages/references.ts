import { canonicalDigest } from "../../canonical/canonical-json";
import type { EvidenceSetId } from "../../domain/identity";
import { err, ok, type Result } from "../../domain/primitives";
import type { EvidenceKind, EvidenceReference, EvidenceSet } from "../evidence";
import type { CapturedItem } from "./capture";

export interface EvidencePackageError { readonly operation: "evidence_packages"; readonly entity_id: string; readonly detail: string }

export function capturedReference(role: string, item: CapturedItem, kind: EvidenceKind, content: EvidenceReference["content"] = null)
  : Result<EvidenceReference, EvidencePackageError> {
  if (!(["raw_build_output", "raw_test_output", "repository_content", "public", "internal"] as readonly unknown[]).includes(kind))
    return err({ operation: "evidence_packages", entity_id: item.occurrence_id, detail: "evidence classification is required" });
  const digest = canonicalDigest(item.selected_value);
  if (!digest.ok) return err({ operation: "evidence_packages", entity_id: item.occurrence_id, detail: digest.error.detail });
  return ok({ ref: `${role}:${item.producer_local_id ?? item.item_id_or_path}`, kind, content,
    digest: digest.value, deep_link: `oakridge://revision/${encodeURIComponent(item.revision_id)}#${item.path}` });
}

export function packagedEvidenceSet(question_id: string, references: readonly EvidenceReference[], reason: string | null)
  : Result<EvidenceSet, EvidencePackageError> {
  const id = canonicalDigest([question_id, references, reason]);
  if (!id.ok) return err({ operation: "evidence_packages", entity_id: question_id, detail: id.error.detail });
  return ok({ evidence_set_id: id.value as unknown as EvidenceSetId, references,
    is_incomplete: reason !== null, incompleteness_reason: reason });
}

export function collectReferences(results: readonly Result<EvidenceReference, EvidencePackageError>[])
  : Result<readonly EvidenceReference[], EvidencePackageError> {
  const references: EvidenceReference[] = [];
  for (const result of results) {
    if (!result.ok) return result;
    references.push(result.value);
  }
  return ok(references);
}
