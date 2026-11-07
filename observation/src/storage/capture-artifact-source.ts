import type { ItemOccurrenceId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { QuestionKey } from "../grading/question";
import type { ArtifactSource, CapturedRevision, CapturedSources, EvidenceCollection, LinkedItem, RepositoryReader,
  SourceArtifact } from "../ports/artifact-source";
import type { EvidenceCollector } from "../ports/producer-profile";
import { withTenant, type Database, type TenantScope } from "./database";
import { readCapturedRunInput } from "./run-capture-store";

export interface CaptureSourceDependencies {
  readonly db: Database;
  readonly tenant: TenantScope;
  readonly run_id: string;
  readonly collector: EvidenceCollector;
  readonly repository: RepositoryReader;
}

/** Reads only observation's captured copies, bounded by tenant and run. What counts as evidence
 * for a question is the injected collector's decision. */
export class CaptureArtifactSource implements ArtifactSource, CapturedSources {
  readonly repository: RepositoryReader;
  constructor(private readonly dependencies: CaptureSourceDependencies) { this.repository = dependencies.repository; }

  async read(occurrence_id: ItemOccurrenceId): Promise<SourceArtifact | null> {
    const { db, tenant, run_id } = this.dependencies;
    return withTenant(db, tenant, async (trx) => {
      const row = await trx.selectFrom("observation.item_occurrence")
        .select(["occurrence_id", "run_id", "revision_id", "json_pointer", "item_kind", "selected_value"])
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("run_id", "=", run_id).where("occurrence_id", "=", occurrence_id).executeTakeFirst();
      return row ? { occurrence_id: row.occurrence_id as ItemOccurrenceId, run_id: row.run_id, revision_id: row.revision_id,
        item_path: row.json_pointer, item_kind: row.item_kind, selected_value: row.selected_value } : null;
    });
  }

  collect(artifact: SourceArtifact, question: QuestionKey): Promise<EvidenceCollection> {
    return this.dependencies.collector.collect(artifact, question, this);
  }

  readRunInput(): Promise<JsonValue | null> {
    const { db, tenant, run_id } = this.dependencies;
    return readCapturedRunInput(db, tenant, run_id);
  }

  async readRevision(revision_id: string): Promise<CapturedRevision | null> {
    const { db, tenant, run_id } = this.dependencies;
    const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision")
      .select(["revision_id", "artifact_kind", "subject_id", "body"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", run_id).where("revision_id", "=", revision_id).executeTakeFirst());
    return row ?? null;
  }

  /** Follows only resolved producer edges to a logical item, then that item's occurrences. */
  async readLinkedItems(occurrence_id: ItemOccurrenceId): Promise<readonly LinkedItem[]> {
    const { db, tenant, run_id } = this.dependencies;
    const rows = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation as relation")
      .innerJoin("observation.item_occurrence as item", (join) => join.onRef("item.producer", "=", "relation.producer")
        .onRef("item.namespace", "=", "relation.namespace").onRef("item.logical_item_id", "=", "relation.target_logical_item_id"))
      .select(["item.revision_id", "item.json_pointer", "item.item_kind", "item.selected_value"]).distinct()
      .where("relation.producer", "=", tenant.producer).where("relation.namespace", "=", tenant.namespace)
      .where("relation.source_occurrence_id", "=", occurrence_id).where("item.run_id", "=", run_id)
      .orderBy("item.revision_id").orderBy("item.json_pointer").execute());
    return rows.map((row) => ({ revision_id: row.revision_id, item_path: row.json_pointer, item_kind: row.item_kind,
      selected_value: row.selected_value }));
  }
}
