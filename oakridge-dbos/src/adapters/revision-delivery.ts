import type { InputBinding } from "../core-client/core-types";
import type { CommittedEventRow, PinnedDefinitionRead } from "../storage/read-store";
import type { CoreEvent } from "../storage/json-column-types";
import { artifactSchemaVersion, bodyDigest, runInputSchemaVersion } from "./observation-schema-version";

export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type RevisionOrigin = { readonly kind: "worker"; readonly action_id: string; readonly seq: number } | { readonly kind: "operator_edit" };
export interface DeliveredRevision {
  readonly revision_id: string;
  readonly run_id: string;
  readonly unit_id: string;
  readonly stage: string;
  readonly artifact: string;
  readonly definition_id: string;
  readonly schema_version: string;
  readonly body: JsonValue;
  readonly body_digest: string;
  readonly predecessor_id: string | null;
  readonly subject_id: string | null;
  readonly origin: RevisionOrigin;
  readonly input_bindings: readonly InputBinding[];
  readonly recorded_at: string;
}
export interface DeliveryCursor { readonly commit_txid: string; readonly event_id: string }
export const INITIAL_DELIVERY_CURSOR: DeliveryCursor = { commit_txid: "0", event_id: "" };
export interface DeliveryAck { readonly cursor: DeliveryCursor }
export interface SessionSettings { readonly harness: string; readonly model: string; readonly effort: string | null }
export interface DeliveryRunConfig {
  readonly sessions: { readonly [stage: string]: { readonly [worker: string]: SessionSettings } };
  readonly grading_enabled: boolean;
}
export type DeliveredEvent =
  | { readonly kind: "revisions"; readonly revisions: readonly DeliveredRevision[] }
  | { readonly kind: "launched"; readonly input: JsonValue; readonly input_schema_version: string; readonly config: DeliveryRunConfig }
  | { readonly kind: "other"; readonly event_kind: string };
export interface CommittedEventDelivery {
  readonly producer: "oakridge";
  readonly namespace: string;
  readonly cursor: DeliveryCursor;
  readonly previous: DeliveryCursor;
  readonly run_id: string;
  readonly event_id: string;
  readonly event: DeliveredEvent;
}

interface DeliveryRow { readonly ordinal: number; readonly revision_id: string }
interface RevisionRow {
  readonly id: string; readonly run_id: string; readonly unit_id: string;
  readonly stage: string | null; readonly artifact: string; readonly body: unknown;
  readonly predecessor_id: string | null; readonly subject: string | null;
  readonly origin_kind: RevisionOrigin["kind"]; readonly by_action_id: string | null; readonly by_seq: number | null;
  readonly input_bindings: readonly InputBinding[]; readonly created_at: Date;
}
interface EventDeliveryRow extends CommittedEventRow<CoreEvent> {
  readonly previous: DeliveryCursor;
  readonly namespace: string;
  readonly config: DeliveryRunConfig;
}
export function selectEventDelivery(row: EventDeliveryRow, deliveries: readonly DeliveryRow[],
  revisions: readonly RevisionRow[], definition: PinnedDefinitionRead | null): CommittedEventDelivery {
  const run_id = row.run_id;
  if (run_id === null) throw new Error(`Event ${row.id} has no run`);
  const base = { producer: "oakridge" as const, namespace: row.namespace, run_id, event_id: row.id,
    cursor: { commit_txid: row.commit_txid, event_id: row.id }, previous: row.previous };
  if (deliveries.length || row.payload.kind === "revision_published") {
    const byId = new Map(revisions.map((revision) => [revision.id, revision]));
    const delivered = [...deliveries].sort((left, right) => left.ordinal - right.ordinal).map(({ revision_id }): DeliveredRevision => {
      const revision = byId.get(revision_id);
      if (!revision?.stage || !definition) throw new Error(`Missing pinned declaration for revision ${revision_id}`);
      const schema_version = artifactSchemaVersion(definition, revision.stage, revision.artifact);
      if (!schema_version) throw new Error(`Missing schema for revision ${revision_id}`);
      if (revision.origin_kind === "worker" && (revision.by_action_id === null || revision.by_seq === null))
        throw new Error(`Missing worker attempt for revision ${revision_id}`);
      const origin: RevisionOrigin = revision.origin_kind === "worker"
        ? { kind: "worker", action_id: revision.by_action_id!, seq: revision.by_seq! } : { kind: "operator_edit" };
      const body = revision.body as JsonValue;
      return { revision_id, run_id, unit_id: revision.unit_id, stage: revision.stage, artifact: revision.artifact,
        definition_id: definition.definition_id, schema_version, body, body_digest: bodyDigest(body),
        predecessor_id: revision.predecessor_id, subject_id: revision.subject, origin, input_bindings: revision.input_bindings,
        recorded_at: revision.created_at.toISOString() };
    });
    return { ...base, event: { kind: "revisions", revisions: delivered } };
  }
  if (row.payload.kind === "launched") {
    if (!definition) throw new Error(`Missing pinned definition for run ${run_id}`);
    return { ...base, event: { kind: "launched", input: row.payload.input as JsonValue, config: row.config,
      input_schema_version: runInputSchemaVersion(definition.checked_program.workflow) } };
  }
  return { ...base, event: { kind: "other", event_kind: row.payload.kind } };
}
