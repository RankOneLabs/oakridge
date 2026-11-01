import type { Event } from "../core-client/core-types";
import type { CommittedEventRow, PinnedDefinitionRead } from "../storage/read-store";
import { artifactSchemaVersion, bodyDigest, declarationDigest } from "./observation-schema-version";
import type { JsonValue, SourceEventOutcome } from "./observation-wire";
import type { Selectable } from "kysely";
import type { AuthorityCollaborationMessage, AuthorityCollaborationThread, AuthorityReviewDecision } from "../storage/db-types";

export const MAPPED_EVENTS = ["revision_published", "operator_decided", "launched"] as const satisfies readonly Event["kind"][];
export const DELIBERATELY_UNMAPPED_EVENTS = ["worker_started", "worker_ended", "retry_requested", "cancel_requested"] as const satisfies readonly Event["kind"][];
/** A new core variant must be handled here or deliberately excluded. */
type MissingEventKind = Exclude<Event["kind"], typeof MAPPED_EVENTS[number] | typeof DELIBERATELY_UNMAPPED_EVENTS[number]>;
const allKindsCovered: MissingEventKind extends never ? true : never = true;
void allKindsCovered;

export interface MappingInput { readonly row: CommittedEventRow<Event>; readonly definition: PinnedDefinitionRead | null;
  readonly namespace: string; readonly stage: string | null; readonly revision_sequence: number | null;
  readonly decision_effect?: "approve" | "request_changes" | null; readonly decision_created_at?: Date;
  readonly decision_id?: string | null }
export function mapObservationEvent(input: MappingInput): SourceEventOutcome {
  const { row, definition } = input;
  const event = row.payload;
  const identity = { run_id: row.run_id ?? "", event_id: row.id };
  const provenance = { format: "observation.source-event/v1", definition_bundle: definition
    ? { id: definition.bundle_id, digest: definition.digest } : null, artifact_schema_version: null } as const;
  const unmapped = (reason: string): SourceEventOutcome => ({ ...provenance, kind: "unmapped", event_kind: event.kind, ...identity, reason });
  switch (event.kind) {
    case "revision_published": {
      if (!definition) return unmapped("pinned definition is missing");
      if (!input.stage) return unmapped(`unit ${event.unit} has no stage`);
      const version = artifactSchemaVersion(definition, input.stage, event.artifact);
      if (!version) return unmapped(`no artifact declaration for ${input.stage}.${event.artifact}`);
      if (input.revision_sequence === null) return unmapped("revision sequence is missing");
      const revision_id = `${event.unit}:${event.artifact}:${input.revision_sequence}`;
      const prefix = `oakridge:${input.namespace}:`;
      return { ...provenance, artifact_schema_version: version, kind: "artifact_revision", event_kind: event.kind, ...identity,
        revision: { format: "observation.artifact-revision/v1", source: {
          producer: "oakridge", namespace: input.namespace, revision_id: `${prefix}${revision_id}`,
          run_id: identity.run_id, unit_id: event.unit, artifact_kind: event.artifact, artifact_schema_version: version,
          collection_key: row.collection_key ?? null,
          definition_bundle: { id: definition.bundle_id, digest: definition.digest },
          predecessor_id: event.predecessor ? `${prefix}${event.predecessor}` : null,
          subject_id: event.subject ? `${prefix}${event.subject}` : null, by_id: event.by ?? null },
          recorded_at: row.created_at.toISOString(), body: event.body as JsonValue, body_digest: bodyDigest(event.body as JsonValue) } };
    }
    case "operator_decided": {
      const targetArtifact = event.target.startsWith(`${event.unit}:`) ? event.target.slice(event.unit.length + 1).split(":")[0] : null;
      const targetVersion = definition && input.stage && targetArtifact ? artifactSchemaVersion(definition, input.stage, targetArtifact) : null;
      return { ...provenance, artifact_schema_version: targetVersion, kind: "human_grade", event_kind: event.kind, ...identity,
        evaluator: { kind: "human" }, unit: event.unit, review: event.review, decision: event.decision,
        decision_id: input.decision_id ?? null,
        target: event.target, feedback: event.payload, effect: input.decision_effect ?? null,
        decided_at: (input.decision_created_at ?? row.created_at).toISOString() };
    }
    case "launched": return definition ? { ...provenance, kind: "run_input", event_kind: event.kind, ...identity, input: event.input,
      input_schema_version: declarationDigest(definition.checked_program.workflow.input as JsonValue) } : unmapped("pinned definition is missing");
    case "worker_started": case "worker_ended": case "retry_requested": case "cancel_requested":
      return { ...provenance, kind: "ignored", event_kind: event.kind, ...identity };
    default: return unmapped(`unrecognized event variant ${String((event as { kind: unknown }).kind)}`);
  }
}

/** Historical rows enter the same event mapper as live decisions. */
export function mapHistoricalDecision(input: Omit<MappingInput, "row" | "revision_sequence"> & {
  readonly decision: Selectable<AuthorityReviewDecision>; readonly event_id: string }): SourceEventOutcome {
  const { decision } = input;
  return mapObservationEvent({ ...input, revision_sequence: null,
    decision_effect: decision.effect, decision_created_at: decision.created_at, decision_id: decision.id,
    row: { id: input.event_id, run_id: decision.run_id, unit_id: decision.unit_id,
      payload: { kind: "operator_decided", unit: decision.unit_id, review: decision.review,
        decision: decision.decision, target: decision.target_revision_id, payload: decision.payload },
      created_at: decision.created_at, commit_txid: "0", was_visible_at_subscription: false } });
}

export function mapCollaborationThread(input: { readonly thread: Selectable<AuthorityCollaborationThread>;
  readonly messages: readonly Selectable<AuthorityCollaborationMessage>[]; readonly definition: PinnedDefinitionRead | null }): SourceEventOutcome {
  const { thread, messages, definition } = input;
  return { format: "observation.source-event/v1", definition_bundle: definition
    ? { id: definition.bundle_id, digest: definition.digest } : null, artifact_schema_version: null,
    kind: "collaboration_thread", event_kind: "collaboration_thread", run_id: thread.run_id,
    event_id: thread.id, unit: thread.unit_id, revision_id: thread.artifact_revision_id,
    context: thread.context, messages: messages.map((message) => ({ id: message.id, body: message.body,
      created_at: message.created_at.toISOString() })) };
}
