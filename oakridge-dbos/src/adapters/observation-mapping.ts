import { ANALYSIS_LINKS_DECLARED } from "../domain/analysis-link-declaration";
import type { CoreEvent } from "../storage/json-column-types";
import type { CommittedEventRow, CommittedRunConfig, PinnedDefinitionRead } from "../storage/read-store";
import { artifactSchemaVersion, bodyDigest, declarationDigest } from "./observation-schema-version";
import type { JsonValue, SourceEventOutcome } from "./observation-wire";

export const MAPPED_EVENTS = ["revision_published", "launched", ANALYSIS_LINKS_DECLARED] as const satisfies readonly CoreEvent["kind"][];
/** Approvals stay in Oakridge: an operator decision advances capture and creates no grading record. */
export const DELIBERATELY_UNMAPPED_EVENTS = ["operator_decided", "worker_started", "worker_ended", "retry_requested", "cancel_requested"] as const satisfies readonly CoreEvent["kind"][];
/** A new core variant must be handled here or deliberately excluded. */
type MissingEventKind = Exclude<CoreEvent["kind"], typeof MAPPED_EVENTS[number] | typeof DELIBERATELY_UNMAPPED_EVENTS[number]>;
const allKindsCovered: MissingEventKind extends never ? true : never = true;
void allKindsCovered;

export interface MappingInput { readonly row: CommittedEventRow<CoreEvent>; readonly definition: PinnedDefinitionRead | null;
  readonly input_provenance?: import("../domain/unit-status").InputProvenanceView;
  readonly namespace: string; readonly stage: string | null; readonly revision_sequence: number | null;
  /** Read for a launch only: its config travels with its input. */
  readonly run_config: CommittedRunConfig | null }
export function mapObservationEvent(input: MappingInput): SourceEventOutcome {
  const { row, definition } = input;
  const event = row.payload;
  const identity = { run_id: row.run_id ?? "", event_id: row.id };
  const provenance = { format: "observation.source-event/v1", definition_id: definition?.definition_id ?? null, artifact_schema_version: null } as const;
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
        revision: { format: "observation.artifact-revision/v4", source: {
          producer: "oakridge", namespace: input.namespace, revision_id: `${prefix}${revision_id}`,
          run_id: identity.run_id, unit_id: event.unit, stage: input.stage, artifact_kind: event.artifact, artifact_schema_version: version,
          definition_id: definition.definition_id,
          brief_revision_ids: ["build_result", "assessment"].includes(event.artifact) && input.input_provenance?.status === "recorded"
            ? input.input_provenance.entries.filter((entry) => entry.input === "brief" || entry.input === "briefs").map((entry) => `${prefix}${entry.revision_id}`) : null,
          predecessor_id: event.predecessor ? `${prefix}${event.predecessor}` : null,
          subject_id: event.subject ? `${prefix}${event.subject}` : null, by_id: event.by ?? null },
          recorded_at: row.created_at.toISOString(), body: event.body as JsonValue, body_digest: bodyDigest(event.body as JsonValue) } };
    }
    case "launched": {
      if (!definition) return unmapped("pinned definition is missing");
      const committed = input.run_config ?? { state: "none" };
      if (committed.state === "malformed") return unmapped("committed run config is malformed");
      return { ...provenance, kind: "run_input", event_kind: event.kind, ...identity, input: event.input,
        input_schema_version: declarationDigest(definition.checked_program.workflow.input as JsonValue),
        config: committed.state === "committed" ? committed.config : null };
    }
    case ANALYSIS_LINKS_DECLARED: {
      const { run_id, tasks_revision_id, entries } = event;
      return { ...provenance, kind: "relation_declaration", event_kind: event.kind, ...identity, declaration: { run_id, tasks_revision_id,
        entries: entries.map(({ source_revision_id, item_path, task_ids }) => ({ source_revision_id, item_path, task_ids })) } };
    }
    case "operator_decided": case "worker_started": case "worker_ended": case "retry_requested": case "cancel_requested":
      return { ...provenance, kind: "ignored", event_kind: event.kind, ...identity };
    default: return unmapped(`unrecognized event variant ${String((event as { kind: unknown }).kind)}`);
  }
}
