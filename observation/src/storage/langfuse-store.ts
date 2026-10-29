import { canonicalDigest } from "../canonical/canonical-json";
import type { CanonicalDigest, EvidenceSetId, ExecutionId, ItemOccurrenceId, QuestionId } from "../domain/identity";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { LangfuseSyncState } from "../langfuse/sync-state";
import type { ExternalTargetIds, LangfuseError, LangfuseObservationId, LangfuseScoreId } from "../ports/evaluation-backend";
import { withTenant, type Database, type DatabaseTransaction, type TenantScope } from "./database";
import type { ObservationLangfuseInboundQuarantine, ObservationLangfuseMapping,
  ObservationLangfuseSyncTransition } from "./db-types";
import { sql, type Selectable } from "kysely";

export type MappingRow = Selectable<ObservationLangfuseMapping>;
export type TransitionRow = Selectable<ObservationLangfuseSyncTransition>;
export type QuarantineRow = Selectable<ObservationLangfuseInboundQuarantine>;
export type SyncStatus = LangfuseSyncState["status"];

/** The contract's projection key is stable; an attempt key keeps deliberate reruns distinct. */
export function mappingKeyForAttempt(base_mapping_key: CanonicalDigest, attempt_id: string): Result<CanonicalDigest, LangfuseError> {
  if (!attempt_id) return err({ operation: "mapping_key", entity_id: base_mapping_key, detail: "attempt id is required" });
  const digest = canonicalDigest([base_mapping_key, attempt_id]);
  return digest.ok ? digest : err({ operation: "mapping_key", entity_id: base_mapping_key, detail: digest.error.detail });
}

export interface LangfuseMappingInput {
  readonly base_mapping_key: CanonicalDigest;
  readonly occurrence_id: ItemOccurrenceId;
  readonly evidence_set_id: EvidenceSetId;
  readonly evidence_set_digest: CanonicalDigest;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly projection_version: string;
  readonly execution_id: ExecutionId;
  readonly attempt_id: string;
  readonly external_ids: ExternalTargetIds | null;
}

function mappingFailure(operation: string, entity_id: string, detail: string): Result<never, LangfuseError> {
  return err({ operation, entity_id, detail });
}

/** Pins and any previously acquired external IDs must agree on every replay. */
function matchesMapping(row: MappingRow, input: LangfuseMappingInput): boolean {
  return row.occurrence_id === input.occurrence_id && row.evidence_set_id === input.evidence_set_id
    && row.evidence_set_digest === input.evidence_set_digest && row.question_id === input.question_id
    && row.question_version === input.question_version && row.projection_version === input.projection_version
    && row.execution_id === input.execution_id && row.attempt_id === input.attempt_id
    && (input.external_ids === null || row.trace_id === null ||
      (row.trace_id === input.external_ids.trace_id && row.observation_id === input.external_ids.observation_id
        && row.score_id === input.external_ids.score_id && row.queue_item_id === input.external_ids.queue_item_id));
}

/** Claims one attempt key, then fills its external IDs at most once. Sync replays preserve its state. */
export async function upsertLangfuseMapping(db: Database, tenant: TenantScope,
  input: LangfuseMappingInput): Promise<Result<MappingRow, LangfuseError>> {
  const key = mappingKeyForAttempt(input.base_mapping_key, input.attempt_id);
  if (!key.ok) return key;
  try {
    return await withTenant(db, tenant, async (trx) => {
      const ids = input.external_ids;
      await trx.insertInto("observation.langfuse_mapping").values({ producer: tenant.producer,
        namespace: tenant.namespace, mapping_key: key.value, occurrence_id: input.occurrence_id,
        evidence_set_id: input.evidence_set_id, evidence_set_digest: input.evidence_set_digest,
        question_id: input.question_id, question_version: input.question_version,
        projection_version: input.projection_version, execution_id: input.execution_id,
        attempt_id: input.attempt_id, trace_id: ids?.trace_id ?? null,
        observation_id: ids?.observation_id ?? null, score_id: ids?.score_id ?? null,
        queue_item_id: ids?.queue_item_id ?? null, sync_state: "queued" })
        .onConflict((conflict) => conflict.columns(["producer", "namespace", "mapping_key"]).doNothing()).execute();
      const row = await trx.selectFrom("observation.langfuse_mapping").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("mapping_key", "=", key.value).forUpdate().executeTakeFirstOrThrow();
      if (!matchesMapping(row, input))
        return mappingFailure("upsert_mapping", key.value, "mapping pins or external identifiers conflict with the existing attempt");
      if (row.trace_id !== null || ids === null) return ok(row);
      const updated = await trx.updateTable("observation.langfuse_mapping").set({ trace_id: ids.trace_id,
        observation_id: ids.observation_id, score_id: ids.score_id, queue_item_id: ids.queue_item_id })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("mapping_key", "=", key.value).returningAll().executeTakeFirstOrThrow();
      return ok(updated);
    });
  } catch (cause) { return mappingFailure("upsert_mapping", key.value, String(cause)); }
}

/** The database trigger appends the initial state and each changed state in the same transaction. */
export async function transitionLangfuseMapping(db: Database, tenant: TenantScope,
  mapping_key: CanonicalDigest, to_state: SyncStatus): Promise<Result<MappingRow, LangfuseError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const row = await trx.selectFrom("observation.langfuse_mapping").selectAll()
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("mapping_key", "=", mapping_key).forUpdate().executeTakeFirst();
      if (!row) return mappingFailure("transition_mapping", mapping_key, "mapping does not exist");
      if (row.sync_state === to_state) return ok(row);
      const updated = await trx.updateTable("observation.langfuse_mapping").set({ sync_state: to_state })
        .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("mapping_key", "=", mapping_key).returningAll().executeTakeFirstOrThrow();
      return ok(updated);
    });
  } catch (cause) { return mappingFailure("transition_mapping", mapping_key, String(cause)); }
}

export async function readLangfuseTransitions(db: Database, tenant: TenantScope,
  mapping_key: CanonicalDigest): Promise<Result<TransitionRow[], LangfuseError>> {
  try {
    return ok(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_sync_transition").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("mapping_key", "=", mapping_key).orderBy("recorded_at").orderBy("transition_id").execute()));
  } catch (cause) { return mappingFailure("read_transitions", mapping_key, String(cause)); }
}

export interface InboundQuarantineInput {
  readonly mapping_key: CanonicalDigest | null;
  readonly score_id: LangfuseScoreId | null;
  readonly observation_id: LangfuseObservationId | null;
  readonly sync_state: SyncStatus;
  readonly raw_payload: JsonValue;
  readonly reason: string;
}

async function insertQuarantine(trx: DatabaseTransaction, tenant: TenantScope,
  input: InboundQuarantineInput): Promise<QuarantineRow> {
  return trx.insertInto("observation.langfuse_inbound_quarantine").values({
    producer: tenant.producer, namespace: tenant.namespace, mapping_key: input.mapping_key,
    score_id: input.score_id, observation_id: input.observation_id, sync_state: input.sync_state,
    raw_payload: sql<JsonValue>`${JSON.stringify(input.raw_payload)}::jsonb`, reason: input.reason,
  }).returningAll().executeTakeFirstOrThrow();
}

export async function quarantineLangfuseInbound(db: Database, tenant: TenantScope,
  input: InboundQuarantineInput): Promise<Result<QuarantineRow, LangfuseError>> {
  if (!input.reason.trim()) return mappingFailure("quarantine_inbound", input.mapping_key ?? "inbound", "reason is required");
  try {
    return ok(await withTenant(db, tenant, (trx) => insertQuarantine(trx, tenant, input)));
  } catch (cause) { return mappingFailure("quarantine_inbound", input.mapping_key ?? "inbound", String(cause)); }
}

export interface InboundScoreInput {
  readonly mapping_key: CanonicalDigest | null;
  readonly score_id: LangfuseScoreId;
  readonly observation_id: LangfuseObservationId;
  readonly raw_payload: JsonValue;
}
export type InboundScorePlacement =
  | { readonly status: "mapped"; readonly mapping: MappingRow }
  | { readonly status: "quarantined"; readonly quarantine: QuarantineRow };

/** Only an exact attempt key and returned external IDs authenticate inbound score placement. */
export async function placeLangfuseInboundScore(db: Database, tenant: TenantScope,
  input: InboundScoreInput): Promise<Result<InboundScorePlacement, LangfuseError>> {
  try {
    return await withTenant(db, tenant, async (trx) => {
      const mapping = input.mapping_key === null ? null : await trx.selectFrom("observation.langfuse_mapping")
        .selectAll().where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
        .where("mapping_key", "=", input.mapping_key).executeTakeFirst();
      if (mapping && mapping.score_id === input.score_id && mapping.observation_id === input.observation_id)
        return ok({ status: "mapped", mapping } as const);
      const quarantine = await insertQuarantine(trx, tenant, { ...input, sync_state: "unmatched",
        reason: mapping ? "external score or observation ID differs from the mapping" : "no authenticated mapping for score and observation" });
      return ok({ status: "quarantined", quarantine } as const);
    });
  } catch (cause) { return mappingFailure("place_inbound_score", input.mapping_key ?? input.score_id, String(cause)); }
}

export async function readLangfuseQuarantine(db: Database, tenant: TenantScope): Promise<Result<QuarantineRow[], LangfuseError>> {
  try {
    return ok(await withTenant(db, tenant, (trx) => trx.selectFrom("observation.langfuse_inbound_quarantine").selectAll()
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .orderBy("recorded_at").orderBy("quarantine_id").execute()));
  } catch (cause) { return mappingFailure("read_quarantine", `${tenant.producer}/${tenant.namespace}`, String(cause)); }
}
