import type { ArtifactRevisionId, ItemOccurrenceId, RunId } from "../domain/identity";
import type { JsonValue } from "../domain/primitives";
import { decodeEvidencePlan, type SubjectQuestion } from "../grading/evidence";
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

/** The columns a logical-item lookup reads from captured occurrences. */
interface CapturedLogicalItemRow {
  readonly revision_id: string;
  readonly json_pointer: string;
  readonly item_kind: string;
  readonly selected_value: JsonValue;
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

  async collect(artifact: SourceArtifact, question: SubjectQuestion): Promise<EvidenceCollection> {
    const { db, tenant, run_id, collector } = this.dependencies;
    const pin = await withTenant(db, tenant, (trx) => trx.selectFrom("observation.evidence_set as e")
      .innerJoin("observation.item_occurrence as i", (join) => join.onRef("i.producer", "=", "e.producer")
        .onRef("i.namespace", "=", "e.namespace").onRef("i.occurrence_id", "=", "e.subject_occurrence_id"))
      .select("e.collection_plan").where("e.producer", "=", tenant.producer).where("e.namespace", "=", tenant.namespace)
      .where("i.run_id", "=", run_id).where("e.subject_occurrence_id", "=", artifact.occurrence_id)
      .where("e.task_id", question.task_id === null ? "is" : "=", question.task_id)
      .where("e.question_id", "=", question.question_id).where("e.question_version", "=", question.question_version).executeTakeFirst());
    if (pin?.collection_plan === null || pin === undefined) return collector.collect(artifact, question, this);
    const plan = decodeEvidencePlan(pin.collection_plan);
    if (!plan.ok) return { state: "not_ready", reason: { code: "invalid_collection_plan", detail: plan.error.detail } };
    return collector.collect(artifact, { ...question, collection_plan: plan.value }, this);
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

  /** Prefer context at the subject revision. Late references may use their first captured definition,
   * never the latest definition: later edits cannot become the context of an older subject. */
  async readLogicalItemAt(request: LogicalItemContextRequest): Promise<LinkedItem | null> {
    const revision = await this.readRevisionAt(request.artifact_kind, request.subject_revision_id);
    const { db, tenant, run_id } = this.dependencies;
    const historical = revision ? await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence")
      .select(["revision_id", "json_pointer", "item_kind", "selected_value"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace).where("run_id", "=", run_id)
      .where("revision_id", "=", revision.revision_id).where("logical_item_id", "=", request.logical_item_id)
      .where("item_kind", "=", request.item_kind).executeTakeFirst()) : null;
    const row = historical ?? (request.allow_late_reference ? await this.readFirstLaterLogicalItem(request) : null);
    return row ? { revision_id: row.revision_id as ArtifactRevisionId, item_path: row.json_pointer, item_kind: row.item_kind,
      selected_value: row.selected_value } : null;
  }

  private async readFirstLaterLogicalItem(request: LogicalItemContextRequest): Promise<CapturedLogicalItemRow | null> {
    const { db, tenant, run_id } = this.dependencies;
    return await withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_occurrence as item")
      .innerJoin("observation.source_revision as context", (join) => join.onRef("context.producer", "=", "item.producer")
        .onRef("context.namespace", "=", "item.namespace").onRef("context.revision_id", "=", "item.revision_id"))
      .innerJoin("observation.source_revision as subject", (join) => join.onRef("subject.producer", "=", "context.producer")
        .onRef("subject.namespace", "=", "context.namespace").onRef("subject.run_id", "=", "context.run_id")
        .on("subject.revision_id", "=", request.subject_revision_id))
      .select(["item.revision_id", "item.json_pointer", "item.item_kind", "item.selected_value"])
      .where("item.producer", "=", tenant.producer).where("item.namespace", "=", tenant.namespace).where("item.run_id", "=", run_id)
      .where("item.logical_item_id", "=", request.logical_item_id).where("item.item_kind", "=", request.item_kind)
      .where("context.artifact_kind", "=", request.artifact_kind)
      .where((eb) => eb.or([eb("context.recorded_at", ">", eb.ref("subject.recorded_at")),
        eb.and([eb("context.recorded_at", "=", eb.ref("subject.recorded_at")), eb("context.captured_at", ">", eb.ref("subject.captured_at"))])]))
      .orderBy("context.captured_at", "asc").orderBy("context.recorded_at", "asc").orderBy("context.revision_id", "asc")
      .orderBy("item.json_pointer", "asc").orderBy("item.occurrence_id", "asc").executeTakeFirst()) ?? null;
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
