import { sql, type Selectable } from "kysely";
import { canonicalJson } from "canonical-json";
import type { ItemOccurrenceId, LogicalItemId, RelationId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import { INITIAL_SOURCE_CURSOR, type SourceEventCursor } from "../ingest/cursor";
import type { ExtractionProfile } from "../ports/producer-profile";
import { selectRevision, type ExtractorDefinition, type LinkReference, type LogicalItemLink, type OccurrenceLink,
  type RelationType, type SelectedItem } from "../projection/extractor";
import { extractionIssue, issueId, type ExtractionIssue } from "../projection/issues";
import { logicalItemId, logicalItemRelation, logicalReference, occurrenceRelation, relationId, revisionAnchorId,
  subjectRelation, type RelationDeclaration, type RelationProposal } from "../projection/relations";
import { occurrenceId } from "../projection/occurrence-id";
import type { CaptureConfiguration } from "../grading/evidence";
import { pinOccurrenceInTransaction } from "./captured-evidence-store";
import { jsonText, withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationItemOccurrence, ObservationSourceRevision } from "./db-types";

export interface ProjectionSummary { readonly occurrences: number; readonly issues: number; readonly relations: number }
export interface Page { readonly limit: number; readonly offset: number }
export interface ItemsPage { readonly items: readonly Selectable<ObservationItemOccurrence>[];
  readonly issues: { readonly items: readonly ExtractionIssue[]; readonly total: number; readonly limit: number; readonly offset: number };
  readonly total: number; readonly limit: number; readonly offset: number }
export interface Republication { readonly predecessor_revision_id: string; readonly is_republication: boolean }
/** One stored relation as a lineage read returns it: the observation.item_relation row, its ids named. */
export interface ItemRelationRead {
  readonly producer: string;
  readonly namespace: string;
  readonly relation_id: RelationId;
  readonly source_occurrence_id: ItemOccurrenceId | null;
  readonly source_logical_item_id: LogicalItemId | null;
  readonly target_occurrence_id: ItemOccurrenceId | null;
  readonly target_logical_item_id: LogicalItemId | null;
  readonly unresolved_target_ref: string | null;
  readonly type: string;
  readonly asserted_by: string;
  readonly evidence_ref: string;
  readonly algorithm: string | null;
  readonly algorithm_version: string | null;
  readonly recorded_at: Date;
}
export interface LineagePage { readonly task_id: LogicalItemId | null; readonly occurrence_id: ItemOccurrenceId; readonly relations: readonly ItemRelationRead[];
  readonly edges: readonly ItemRelationRead[];
  readonly unresolved: readonly ItemRelationRead[]; readonly total: number;
  readonly limit: number; readonly offset: number; readonly republication: Republication | null }
interface StoredSelection { readonly occurrence_id: string; readonly item: SelectedItem; readonly definition: ExtractorDefinition; readonly is_new: boolean }
/** What a capture needs from composition: how to select items, and what to pin to new ones. */
export interface ProjectionContext {
  readonly extraction: ExtractionProfile;
  readonly configuration: CaptureConfiguration;
}
const scope = (tenant: TenantScope): TenantScope => ({ producer: tenant.producer, namespace: tenant.namespace });

function sameJson(left: JsonValue, right: JsonValue): boolean {
  const a = canonicalJson(left);
  const b = canonicalJson(right);
  return a.ok && b.ok && a.value === b.value;
}
async function saveIssue(trx: DatabaseTransaction, tenant: TenantScope, issue: ExtractionIssue): Promise<void> {
  await trx.insertInto("observation.extraction_issue").values({ ...scope(tenant), issue_id: issueId(issue), ...issue })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "issue_id"]).doNothing()).execute();
}
async function saveDefinition(trx: DatabaseTransaction, tenant: TenantScope, definition: ExtractorDefinition): Promise<void> {
  const { artifact_kind, schema_version, extractor_id, extractor_version, item_kind, item_selector } = definition;
  await trx.insertInto("observation.extractor_definition").values({ ...scope(tenant), artifact_kind, schema_version,
    extractor_id, extractor_version, item_kind, item_selector })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "artifact_kind", "schema_version", "extractor_id", "extractor_version"]).doNothing()).execute();
}
async function saveOccurrence(trx: DatabaseTransaction, tenant: TenantScope, revision: Selectable<ObservationSourceRevision>,
  definition: ExtractorDefinition, item: SelectedItem, configuration: CaptureConfiguration): Promise<StoredSelection | null> {
  const identity = occurrenceId({ ...tenant, revision_id: revision.revision_id, extractor_id: definition.extractor_id,
    extractor_version: definition.extractor_version, item_selector: item.item_selector, item_id_or_path: item.item_id_or_path });
  if (!identity.ok) throw new Error(identity.error.detail);
  const occurrence_id = identity.value;
  const logical_item_id = item.item_scope && item.producer_local_id ? await saveLogicalItem(trx, tenant, revision.run_id,
    item.item_scope, item.producer_local_id, configuration) : null;
  const row = { ...scope(tenant), occurrence_id, revision_id: revision.revision_id, run_id: revision.run_id,
    artifact_kind: revision.artifact_kind, schema_version: revision.artifact_schema_version,
    extractor_id: definition.extractor_id, extractor_version: definition.extractor_version,
    item_kind: item.item_kind, item_selector: item.item_selector, item_id_or_path: item.item_id_or_path,
    item_scope: item.item_scope, producer_local_id: item.producer_local_id,
    selected_value: jsonText(item.selected_value), logical_item_id,
    json_pointer: item.path };
  const inserted = await trx.insertInto("observation.item_occurrence").values(row)
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "occurrence_id"]).doNothing())
    .returning("occurrence_id").executeTakeFirst();
  const existing = await trx.selectFrom("observation.item_occurrence").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("occurrence_id", "=", occurrence_id).executeTakeFirstOrThrow();
  if (!sameJson(existing.selected_value, item.selected_value) || existing.item_scope !== item.item_scope
    || existing.producer_local_id !== item.producer_local_id || existing.revision_id !== revision.revision_id) {
    await saveIssue(trx, tenant, extractionIssue(revision.revision_id, definition.extractor_id,
      definition.extractor_version, item.item_selector, "identity_collision"));
    return null;
  }
  // Pins belong to the first capture only: a replay under a later configuration must not repin.
  return { occurrence_id, item, definition, is_new: inserted !== undefined };
}

/** Saving a logical item settles any reference that reached this run before the item did. */
async function saveLogicalItem(trx: DatabaseTransaction, tenant: TenantScope, run_id: string, item_scope: string,
  producer_local_id: string, configuration: CaptureConfiguration): Promise<string> {
  const logical_item_id = logicalItemId({ ...tenant, run_id, scope: item_scope, producer_local_id });
  await trx.insertInto("observation.logical_item").values({ ...scope(tenant), logical_item_id, run_id, scope: item_scope, producer_local_id })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "logical_item_id"]).doNothing()).execute();
  const resolved = await sql<{ source_occurrence_id: string; item_kind: string }>`UPDATE observation.item_relation relation
    SET target_logical_item_id = ${logical_item_id}, unresolved_target_ref = NULL
    FROM observation.item_occurrence source
    WHERE relation.producer = ${tenant.producer} AND relation.namespace = ${tenant.namespace}
      AND relation.unresolved_target_ref = ${logicalReference(item_scope, producer_local_id)}
      AND source.producer = relation.producer AND source.namespace = relation.namespace
      AND source.occurrence_id = relation.source_occurrence_id AND source.run_id = ${run_id}
    RETURNING source.occurrence_id AS source_occurrence_id, source.item_kind`.execute(trx);
  // Newly resolved subjects use the configuration in force now. Existing pins never change.
  for (const source of resolved.rows) await pinOccurrenceInTransaction(trx, tenant,
    source.source_occurrence_id as ItemOccurrenceId, source.item_kind,
    { pins: configuration.pins.filter((pin) => pin.scope === "per_task") }, logical_item_id as LogicalItemId);
  return logical_item_id;
}

async function targetOccurrence(trx: DatabaseTransaction, tenant: TenantScope,
  source: Selectable<ObservationSourceRevision>, link: OccurrenceLink): Promise<string | null | undefined> {
  const scope = link.target_scope;
  const candidates = await sql<{ occurrence_id: string; item_scope: string | null; revision_id: string }>`
    SELECT i.occurrence_id, i.item_scope, i.revision_id
    FROM observation.item_occurrence i
    JOIN observation.source_revision r USING (producer, namespace, revision_id)
    WHERE i.producer = ${tenant.producer} AND i.namespace = ${tenant.namespace}
      AND i.run_id = ${source.run_id} AND i.artifact_kind = ${link.target_artifact_kind}
      AND i.item_kind = ${link.target_item_kind} AND i.producer_local_id = ${link.target_local_id}
      AND (${scope}::text IS NULL OR i.item_scope = ${scope})
      AND r.recorded_at <= ${source.recorded_at}
    ORDER BY i.revision_id, i.occurrence_id`.execute(trx);
  const eligible = link.target_artifact_kind === source.artifact_kind
    ? candidates.rows.filter((row) => row.revision_id === source.revision_id) : candidates.rows;
  if (eligible.length === 0) return null;
  // A local id alone does not identify which prior revision was approved.
  if (eligible.length > 1) return undefined;
  return eligible[0]?.occurrence_id ?? null;
}
async function saveRelation(trx: DatabaseTransaction, tenant: TenantScope, proposal: RelationProposal): Promise<void> {
  const source_occurrence_id = proposal.source.kind === "occurrence" ? proposal.source.id : null;
  const source_logical_item_id = proposal.source.kind === "logical_item" ? proposal.source.id : null;
  const target_occurrence_id = proposal.target.kind === "occurrence" ? proposal.target.id : null;
  const target_logical_item_id = proposal.target.kind === "logical_item" ? proposal.target.id : null;
  const unresolved_target_ref = proposal.target.kind === "unresolved" ? proposal.target.ref : null;
  await trx.insertInto("observation.item_relation").values({ ...scope(tenant), relation_id: relationId(proposal),
    source_occurrence_id, source_logical_item_id, target_occurrence_id, target_logical_item_id,
    unresolved_target_ref, type: proposal.type, asserted_by: proposal.asserted_by,
    evidence_ref: proposal.evidence_ref, algorithm: proposal.algorithm, algorithm_version: proposal.algorithm_version })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "relation_id"]).doUpdateSet({
      target_occurrence_id, target_logical_item_id, unresolved_target_ref,
    })).execute();
}

/** The target stays unresolved, and visible, until that run captures the logical item. */
async function saveLogicalItemRelation(trx: DatabaseTransaction, tenant: TenantScope, run_id: string,
  source_occurrence_id: string, link: LogicalItemLink): Promise<string> {
  const logical_item_id = logicalItemId({ ...tenant, run_id, scope: link.target_scope, producer_local_id: link.target_local_id });
  const target = await trx.selectFrom("observation.logical_item").select("logical_item_id")
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("logical_item_id", "=", logical_item_id).executeTakeFirst();
  const proposal = logicalItemRelation(source_occurrence_id, link, target?.logical_item_id ?? null);
  await saveRelation(trx, tenant, proposal);
  return relationId(proposal);
}

async function saveLink(trx: DatabaseTransaction, tenant: TenantScope, revision: Selectable<ObservationSourceRevision>,
  source_occurrence_id: string, link: LinkReference): Promise<boolean> {
  if (link.target === "logical_item") {
    await saveLogicalItemRelation(trx, tenant, revision.run_id, source_occurrence_id, link);
    return true;
  }
  const target = await targetOccurrence(trx, tenant, revision, link);
  if (target === null && link.if_present) return false;
  await saveRelation(trx, tenant, occurrenceRelation(source_occurrence_id, link, target ?? null));
  return true;
}

export interface RelationDeclarationError { readonly operation: "declare_relation"; readonly entity_id: string; readonly detail: string }

/** Serializes writers of one tenant's feed, so a target and an edge to it cannot miss each other. */
export async function lockSourceCursor(trx: DatabaseTransaction, tenant: TenantScope): Promise<SourceEventCursor> {
  await sql`INSERT INTO observation.source_event_cursor (producer, namespace) VALUES (${tenant.producer}, ${tenant.namespace})
    ON CONFLICT DO NOTHING`.execute(trx);
  const selected = await sql<SourceEventCursor>`SELECT commit_txid::text AS commit_txid, event_id AS id
    FROM observation.source_event_cursor WHERE producer = ${tenant.producer} AND namespace = ${tenant.namespace} FOR UPDATE`.execute(trx);
  return selected.rows[0] ?? INITIAL_SOURCE_CURSOR;
}

/** A late link only adds an edge: the occurrence, its pins, evidence and answers stay as they are. */
export async function declareRelationInTransaction(trx: DatabaseTransaction, tenant: TenantScope, declaration: RelationDeclaration)
  : Promise<Result<string, RelationDeclarationError>> {
  await lockSourceCursor(trx, tenant);
  const source = await trx.selectFrom("observation.item_occurrence").select(["occurrence_id", "run_id"])
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("revision_id", "=", declaration.source_revision_id).where("json_pointer", "=", declaration.item_path).executeTakeFirst();
  // The exact address decides, inside the declared run: another run's revision never satisfies it.
  if (source?.run_id !== declaration.run_id) return err({ operation: "declare_relation", entity_id: declaration.source_revision_id,
    detail: `no captured item at ${declaration.item_path} in run ${declaration.run_id}` });
  return ok(await saveLogicalItemRelation(trx, tenant, source.run_id, source.occurrence_id, declaration.link));
}

async function saveRevisionAnchor(trx: DatabaseTransaction, tenant: TenantScope,
  revision: Selectable<ObservationSourceRevision>): Promise<string> {
  const logical_item_id = revisionAnchorId(revision);
  await trx.insertInto("observation.logical_item").values({ ...scope(tenant), logical_item_id,
    run_id: revision.run_id, scope: `artifact_revision/${revision.artifact_kind}`,
    producer_local_id: revision.revision_id })
    .onConflict((conflict) => conflict.columns(["producer", "namespace", "logical_item_id"]).doNothing()).execute();
  return logical_item_id;
}

async function saveSubjectRelation(trx: DatabaseTransaction, tenant: TenantScope,
  revision: Selectable<ObservationSourceRevision>, extraction: ExtractionProfile): Promise<boolean> {
  const link = extraction.revisionLink(revision);
  if (!link) return false;
  const source = await saveRevisionAnchor(trx, tenant, revision);
  const targetRevision = await trx.selectFrom("observation.source_revision").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("run_id", "=", revision.run_id).where("artifact_kind", "=", link.target_artifact_kind)
    .where("revision_id", "=", link.subject_revision_id).executeTakeFirst();
  const target = targetRevision ? await saveRevisionAnchor(trx, tenant, targetRevision) : null;
  await saveRelation(trx, tenant, subjectRelation(source, target, link.target_artifact_kind, link.subject_revision_id));
  return true;
}

/** Replaying a captured revision is idempotent; its body and digest are only read. */
export async function projectRevisionInTransaction(trx: DatabaseTransaction, tenant: TenantScope, revision_id: string,
  context: ProjectionContext): Promise<ProjectionSummary | null> {
  const revision = await trx.selectFrom("observation.source_revision").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("revision_id", "=", revision_id).executeTakeFirst();
  if (!revision) return null;
  const definitions = context.extraction.definitions(revision.artifact_kind, revision.artifact_schema_version);
  const pass = selectRevision(revision.body, revision.revision_id, definitions);
  for (const definition of definitions) await saveDefinition(trx, tenant, definition);
  for (const issue of pass.issues) await saveIssue(trx, tenant, issue);
  const seen = new Set<string>();
  const selections: StoredSelection[] = [];
  let collisionCount = 0;
  for (const { definition, item } of pass.items) {
    const identity = occurrenceId({ ...tenant, revision_id, extractor_id: definition.extractor_id,
      extractor_version: definition.extractor_version, item_selector: item.item_selector,
      item_id_or_path: item.item_id_or_path });
    if (!identity.ok) throw new Error(identity.error.detail);
    if (seen.has(identity.value)) {
      collisionCount++;
      await saveIssue(trx, tenant, extractionIssue(revision_id, definition.extractor_id,
        definition.extractor_version, item.item_selector, "identity_collision"));
      continue;
    }
    seen.add(identity.value);
    const stored = await saveOccurrence(trx, tenant, revision, definition, item, context.configuration);
    if (stored) selections.push(stored);
    else collisionCount++;
  }
  let relationCount = 0;
  for (const selection of selections) for (const link of selection.item.links)
    if (await saveLink(trx, tenant, revision, selection.occurrence_id, link)) relationCount++;
  for (const selection of selections.filter((selection) => selection.is_new))
    await pinOccurrenceInTransaction(trx, tenant, selection.occurrence_id as ItemOccurrenceId, selection.item.item_kind, context.configuration);
  if (await saveSubjectRelation(trx, tenant, revision, context.extraction)) relationCount++;
  return { occurrences: selections.length, issues: pass.issues.length + collisionCount, relations: relationCount };
}

export function listRunItems(db: Database, tenant: TenantScope, run_id: string, page: Page, issues_page: Page = page): Promise<ItemsPage> {
  return withTenant(db, tenant, async (trx) => {
    const query = trx.selectFrom("observation.item_occurrence").where("producer", "=", tenant.producer)
      .where("namespace", "=", tenant.namespace).where("run_id", "=", run_id);
    const count = await query.select(sql<string>`count(*)::text`.as("count")).executeTakeFirstOrThrow();
    const items = await query.selectAll().orderBy("revision_id", "asc").orderBy("occurrence_id", "asc")
      .limit(page.limit).offset(page.offset).execute();
    const issues = trx.selectFrom("observation.extraction_issue as e")
      .innerJoin("observation.source_revision as r", (join) => join.onRef("e.producer", "=", "r.producer")
        .onRef("e.namespace", "=", "r.namespace").onRef("e.revision_id", "=", "r.revision_id"))
      .where("e.producer", "=", tenant.producer).where("e.namespace", "=", tenant.namespace).where("r.run_id", "=", run_id);
    const issueCount = await issues.select(sql<string>`count(*)::text`.as("count")).executeTakeFirstOrThrow();
    const issueRows = await issues.select(["e.revision_id", "e.extractor_id", "e.extractor_version", "e.item_selector", "e.kind", "e.detail", "e.is_retriable"])
      .orderBy("e.issue_id", "asc").limit(issues_page.limit).offset(issues_page.offset).execute();
    return { items, issues: { items: issueRows as ExtractionIssue[], total: Number(issueCount.count), ...issues_page }, total: Number(count.count), ...page };
  });
}

export function readItem(db: Database, tenant: TenantScope, occurrence_id: string): Promise<Selectable<ObservationItemOccurrence> | null> {
  return withTenant(db, tenant, async (trx) => (await trx.selectFrom("observation.item_occurrence").selectAll()
    .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
    .where("occurrence_id", "=", occurrence_id).executeTakeFirst()) ?? null);
}

/** The occurrences that declared an edge of this type into one logical item. A composite
 * reaches answers through these, so a shared task lists each linked occurrence once. */
export function listRelatedOccurrences(db: Database, tenant: TenantScope, logical_item_id: string, type: RelationType,
  page: Page): Promise<readonly Selectable<ObservationItemOccurrence>[]> {
  return withTenant(db, tenant, (trx) => trx.selectFrom("observation.item_relation as relation")
    .innerJoin("observation.item_occurrence as source", (join) => join.onRef("source.producer", "=", "relation.producer")
      .onRef("source.namespace", "=", "relation.namespace").onRef("source.occurrence_id", "=", "relation.source_occurrence_id"))
    .selectAll("source").distinct()
    .where("relation.producer", "=", tenant.producer).where("relation.namespace", "=", tenant.namespace)
    .where("relation.target_logical_item_id", "=", logical_item_id).where("relation.type", "=", type)
    .orderBy("source.revision_id").orderBy("source.occurrence_id").limit(page.limit).offset(page.offset).execute());
}

export function readLineage(db: Database, tenant: TenantScope, occurrence_id: string, page: Page, task_id?: LogicalItemId): Promise<LineagePage | null> {
  return withTenant(db, tenant, async (trx) => {
    const item = await trx.selectFrom("observation.item_occurrence").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", occurrence_id).executeTakeFirst();
    if (!item) return null;
    const revision = await trx.selectFrom("observation.source_revision")
      .select(["predecessor_id", "body_digest"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("revision_id", "=", item.revision_id).executeTakeFirstOrThrow();
    const predecessor = revision.predecessor_id ? await trx.selectFrom("observation.source_revision")
      .select(["revision_id", "body_digest"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", item.run_id).where("artifact_kind", "=", item.artifact_kind)
      .where("revision_id", "=", revision.predecessor_id).executeTakeFirst() : null;
    const republication: Republication | null = predecessor
      ? { predecessor_revision_id: `${tenant.producer}:${tenant.namespace}:${predecessor.revision_id}`,
        is_republication: revision.body_digest === predecessor.body_digest } : null;
    const occurrences = await trx.selectFrom("observation.item_occurrence").select(["occurrence_id", "logical_item_id"])
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("run_id", "=", item.run_id).execute();
    const logicalByOccurrence = new Map(occurrences.map((row) => [row.occurrence_id, row.logical_item_id]));
    const relations = (await sql<ItemRelationRead>`
      SELECT rel.* FROM observation.item_relation rel
      WHERE rel.producer = ${tenant.producer} AND rel.namespace = ${tenant.namespace}
        AND (
          EXISTS (SELECT 1 FROM observation.item_occurrence source_item
            WHERE source_item.producer = rel.producer AND source_item.namespace = rel.namespace
              AND source_item.occurrence_id = rel.source_occurrence_id AND source_item.run_id = ${item.run_id})
          OR EXISTS (SELECT 1 FROM observation.logical_item source_item
            WHERE source_item.producer = rel.producer AND source_item.namespace = rel.namespace
              AND source_item.logical_item_id = rel.source_logical_item_id AND source_item.run_id = ${item.run_id})
        )
      ORDER BY rel.relation_id ASC`.execute(trx)).rows;
    const reached = new Set<string>([occurrence_id]);
    const reachedLogical = new Set<string>([revisionAnchorId(item), ...(item.logical_item_id ? [item.logical_item_id] : [])]);
    const connected = new Set<string>();
    let changed = true;
    while (changed) {
      changed = false;
      for (const relation of relations) {
        const touches = (relation.source_occurrence_id && reached.has(relation.source_occurrence_id))
          || (relation.target_occurrence_id && reached.has(relation.target_occurrence_id))
          || (relation.source_logical_item_id && reachedLogical.has(relation.source_logical_item_id))
          || (relation.target_logical_item_id && reachedLogical.has(relation.target_logical_item_id));
        if (!touches || connected.has(relation.relation_id)) continue;
        connected.add(relation.relation_id);
        changed = true;
        for (const endpoint of [relation.source_occurrence_id, relation.target_occurrence_id]) if (endpoint && logicalByOccurrence.has(endpoint)) {
          reached.add(endpoint);
          const logical = logicalByOccurrence.get(endpoint);
          if (logical) reachedLogical.add(logical);
        }
        for (const logical of [relation.source_logical_item_id, relation.target_logical_item_id]) if (logical) reachedLogical.add(logical);
      }
    }
    const ordered = relations.filter((relation) => connected.has(relation.relation_id)
      && (task_id === undefined || relation.type !== "assesses" || relation.target_logical_item_id === task_id));
    const slice = ordered.slice(page.offset, page.offset + page.limit);
    return { task_id: task_id ?? null, occurrence_id: occurrence_id as ItemOccurrenceId, relations: slice, edges: slice.filter((relation) => relation.unresolved_target_ref === null),
      unresolved: slice.filter((relation) => relation.unresolved_target_ref !== null),
      total: ordered.length, ...page, republication };
  });
}
