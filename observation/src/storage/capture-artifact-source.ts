import type { ArtifactRevisionId, ItemOccurrenceId, RunId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import type { SubjectQuestion } from "../grading/evidence";
import type { ArtifactSource, CapturedRevision, CapturedSources, EvidenceCollection, LinkedItem, LogicalItemContextRequest, RepositoryReader,
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
      return row ? { occurrence_id: row.occurrence_id as ItemOccurrenceId, run_id: row.run_id as RunId, revision_id: row.revision_id as ArtifactRevisionId,
        item_path: row.json_pointer, item_kind: row.item_kind, selected_value: row.selected_value } : null;
    });
  }

  collect(artifact: SourceArtifact, question: SubjectQuestion): Promise<EvidenceCollection> {
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
    return row ? { ...row, revision_id: row.revision_id as ArtifactRevisionId } : null;
  }

  async readRevisionAt(artifact_kind: string, subject_revision_id: ArtifactRevisionId): Promise<CapturedRevision | null> {
    const { db, tenant, run_id } = this.dependencies;
    const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.source_revision as context")
      .innerJoin("observation.source_revision as subject", (join) => join.onRef("subject.producer", "=", "context.producer")
        .onRef("subject.namespace", "=", "context.namespace").onRef("subject.run_id", "=", "context.run_id")
        .on("subject.revision_id", "=", subject_revision_id))
      .select(["context.revision_id", "context.artifact_kind", "context.subject_id", "context.body"])
      .where("context.producer", "=", tenant.producer).where("context.namespace", "=", tenant.namespace)
      .where("context.run_id", "=", run_id).where("context.artifact_kind", "=", artifact_kind)
      .where((eb) => eb.or([eb("context.recorded_at", "<", eb.ref("subject.recorded_at")),
        eb.and([eb("context.recorded_at", "=", eb.ref("subject.recorded_at")), eb("context.captured_at", "<=", eb.ref("subject.captured_at"))])]))
      .orderBy("context.recorded_at", "desc").orderBy("context.captured_at", "desc").orderBy("context.revision_id", "desc")
      .executeTakeFirst());
    return row ? { ...row, revision_id: row.revision_id as ArtifactRevisionId } : null;
  }

  /** One logical item at the source position and selection requested by the producer. */
  async readLogicalItemAt(request: LogicalItemContextRequest): Promise<LinkedItem | null> {
    const revision = await this.readRevisionAt(request.artifact_kind, request.subject_revision_id);
    if (!revision) return null;
    const { db, tenant, run_id } = this.dependencies;
    const row = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id)
      .where("revision_id", "=", revision.revision_id).where("logical_item_id", "=", request.logical_item_id).where("item_kind", "=", request.item_kind).executeTakeFirst());
    return row ? { revision_id: revision.revision_id, item_path: row.json_pointer, item_kind: row.item_kind,
      selected_value: row.selected_value } : null;
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
    return rows.map((row) => ({ revision_id: row.revision_id as ArtifactRevisionId, item_path: row.json_pointer, item_kind: row.item_kind,
      selected_value: row.selected_value }));
  }
}
