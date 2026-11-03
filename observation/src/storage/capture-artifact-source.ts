import { canonicalDigest } from "canonical-json";
import type { ItemOccurrenceId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { EvidenceReference, EvidenceSet } from "../grading/evidence";
import { packagedEvidenceSet } from "../grading/evidence-packages/references";
import type { ArtifactSource, SourceArtifact } from "../ports/artifact-source";
import { withTenant, type Database, type TenantScope } from "./database";

function object(value: JsonValue): Readonly<{ [key: string]: JsonValue }> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Readonly<{ [key: string]: JsonValue }> : null;
}

/** Evidence refs in assessment_finding use the captured producer's {kind, ref, detail} contract.
 * Only explicit file addresses into a captured revision can supply repository content. */
function fileAddresses(value: JsonValue): readonly URL[] {
  const evidence = object(value)?.evidence;
  if (!Array.isArray(evidence)) return [];
  return evidence.flatMap((entry) => {
    const ref = object(entry);
    if (ref?.kind !== "file" || typeof ref.ref !== "string" || !URL.canParse(ref.ref)) return [];
    const address = new URL(ref.ref);
    return address.protocol === "oakridge:" && address.hostname === "revision" && address.hash.startsWith("#/")
      ? [address] : [];
  });
}
function valueAtPointer(body: JsonValue, pointer: string): JsonValue | null {
  let value = body;
  for (const token of pointer.slice(1).split("/")) {
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return null;
      value = value[Number(key)] ?? null;
    } else {
      const fields = object(value);
      if (!fields || !Object.hasOwn(fields, key)) return null;
      value = fields[key];
    }
  }
  return value;
}

/** Reads only observation capture copies, bounded by tenant, run and exact addressed revision. */
export class CaptureArtifactSource implements ArtifactSource {
  constructor(private readonly db: Database, private readonly tenant: TenantScope, private readonly run_id: string) {}

  async read(occurrence_id: ItemOccurrenceId): Promise<SourceArtifact | null> {
    return withTenant(this.db, this.tenant, async (trx) => {
      const row = await trx.selectFrom("observation.item_occurrence").select(["occurrence_id", "item_kind", "selected_value"])
        .where("producer", "=", this.tenant.producer).where("namespace", "=", this.tenant.namespace)
        .where("run_id", "=", this.run_id).where("occurrence_id", "=", occurrence_id).executeTakeFirst();
      return row ? { ...row, occurrence_id: row.occurrence_id as ItemOccurrenceId } : null;
    });
  }

  async collect(artifact: SourceArtifact): Promise<EvidenceSet> {
    const stored = await this.read(artifact.occurrence_id);
    const references: EvidenceReference[] = [];
    for (const address of stored ? fileAddresses(stored.selected_value) : []) {
      const revision_id = decodeURIComponent(address.pathname.slice(1));
      const pointer = decodeURIComponent(address.hash.slice(1));
      const revision = await withTenant(this.db, this.tenant, (trx) => trx.selectFrom("observation.source_revision")
        .select(["body", "artifact_kind"]).where("producer", "=", this.tenant.producer)
        .where("namespace", "=", this.tenant.namespace).where("run_id", "=", this.run_id)
        .where("revision_id", "=", revision_id).where("artifact_kind", "in", ["repository_content", "repository_snapshot"])
        .executeTakeFirst());
      if (!revision) continue;
      const content = valueAtPointer(revision.body, pointer);
      if (content === null) continue;
      const digest = canonicalDigest(content);
      if (!digest.ok) continue;
      const metadata = object(revision.body);
      references.push({ ref: `repository_content:${revision_id}#${pointer}`, kind: "repository_content", content,
        digest: digest.value, deep_link: `oakridge://revision/${encodeURIComponent(revision_id)}#${pointer}`,
        ...(typeof metadata?.head_sha === "string" ? { reviewed_commit: metadata.head_sha } : {}),
        ...(metadata?.is_truncated === true ? { is_truncated: true } : {}),
        ...(metadata?.is_unreadable === true ? { is_unreadable: true } : {}),
        ...(typeof metadata?.incompleteness_reason === "string" ? { incompleteness_reason: metadata.incompleteness_reason } : {}),
      });
    }
    const result = packagedEvidenceSet(artifact.occurrence_id, references,
      references.length === 0 ? "no addressed repository content was captured for this occurrence" : null);
    if (!result.ok) throw new Error(result.error.detail);
    return result.value;
  }
}
