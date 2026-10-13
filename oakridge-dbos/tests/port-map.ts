/**
 * The R4 port map (rescue spec §4.4): every field of each v1 operator read
 * model at 9b12e34c, and what became of it in v2. A field is kept, renamed by
 * the §2.3 table, or removed by a recorded decision; `added` lists v2 fields
 * with no v1 counterpart. read-models.test.ts holds each projection's fields to
 * exactly this list.
 */
export type FieldFate = { readonly kind: "kept" } | { readonly kind: "renamed"; readonly to: string } | { readonly kind: "removed"; readonly by: RemovalDecision };
/** The decisions a removal cites, recorded in part 1 §12 ("Recorded with rescue R4"). */
export type RemovalDecision =
  /** No v2 source and never read by the PWA (R4, accepted by the operator). */
  | "no_v2_source"
  /** Presentation moved to the PWA's artifact registry (rescue spec §3.1). */
  | "presentation_in_pwa"
  /** Definition editing is part 2's open product call; v2 dropped `definition_bundle.authoring`. */
  | "no_authoring";
export interface ReadModelPort {
  readonly v1: string;
  readonly fields: Readonly<Record<string, FieldFate>>;
  readonly added: readonly string[];
}

const kept: FieldFate = { kind: "kept" };
const to = (name: string): FieldFate => ({ kind: "renamed", to: name });
const removed = (by: RemovalDecision = "no_v2_source"): FieldFate => ({ kind: "removed", by });

export const PORT_MAP = {
  RunSummary: { v1: "RunSummary", fields: { run_id: kept, definition_bundle_id: kept, definition_digest: kept, version: kept, created_at: kept, archived_at: kept },
    added: ["status"] },
  RunView: { v1: "RunView", fields: { run_id: kept, definition_bundle_id: kept, definition_digest: kept, version: kept, created_at: kept, archived_at: kept,
    cursor: kept, scopes: to("units") }, added: ["status"] },
  RunCursorEntry: { v1: "RunView.cursor[]", fields: { scope_id: to("unit_id"), version: kept }, added: [] },
  RunUnitSummary: { v1: "RunScopeSummary", fields: { scope_id: to("unit_id"), scope_key: to("unit_key"), label: kept, version: kept, is_terminal: kept,
    available_commands: to("available_decisions") }, added: ["stage", "status"] },
  UnitView: { v1: "ScopeView", fields: { scope_id: to("unit_id"), run_id: kept, scope_key: to("unit_key"), label: kept, state: kept, outcome: kept,
    is_terminal: kept, commands: to("decisions"), executions: to("attempts"), outputs: to("artifacts"), resources: removed(),
    command_targets: to("decision_targets"), command_prefill: to("decision_prefill"), decision: kept, cursor: kept },
    added: ["stage", "collection_key", "input", "depends_on"] },
  UnitCursor: { v1: "ProjectionCursor", fields: { scope_version: to("unit_version"), transition_id: removed() }, added: [] },
  Decision: { v1: "Decision", fields: { decision: kept, cursor: kept }, added: [] },
  AttemptView: { v1: "ExecutionView", fields: { id: kept, scope_id: to("unit_id"), worker_key: kept, generation: kept, status: kept, result: kept, version: kept },
    added: ["mode", "cause", "kbbl_session_id", "created_at", "is_current"] },
  ArtifactView: { v1: "OutputSlotView", fields: { id: kept, run_id: kept, scope_id: to("unit_id"), output_key: to("artifact_key"), collection_key: kept,
    current_revision_id: to("latest_revision_id"), version: kept, current_revision: to("latest_revision") }, added: ["schema", "reviewable"] },
  ArtifactRevisionView: { v1: "ArtifactRevisionRecord", fields: { id: kept, run_id: kept, scope_id: to("unit_id"), execution_id: to("attempt_id"),
    output_key: to("artifact_key"), collection_key: kept, body: kept, predecessor_id: kept, created_at: kept, version: kept }, added: ["subject_id"] },
  DecisionDefinition: { v1: "CommandDefinition", fields: { available_in: removed(), consequence: kept, field_presentation: kept, key: kept, label: kept,
    payload_schema: kept, prefill: kept, required: removed(), targets: kept }, added: ["submit"] },
  InboxPage: { v1: "InboxPage", fields: { cursor: kept, items: kept, next_cursor: kept }, added: [] },
  InboxDecisionItem: { v1: "InboxItem (command)", fields: { kind: kept, run_id: kept, scope_id: to("unit_id"), scope_version: to("unit_version"), key: kept,
    label: kept, consequence: kept }, added: ["submit", "prompt"] },
  InboxWaitItem: { v1: "InboxItem (wait)", fields: { kind: kept, run_id: kept, scope_id: to("unit_id"), scope_version: to("unit_version"), reason: kept,
    label: kept }, added: [] },
  InboxDiagnosticItem: { v1: "InboxItem (diagnostic)", fields: { kind: kept, run_id: kept, scope_id: to("unit_id"), scope_version: to("unit_version"),
    detail: kept }, added: [] },
  UnitHistory: { v1: "ScopeHistory", fields: { scope_id: to("unit_id"), transitions: to("events"), facts: removed() }, added: ["next_cursor"] },
  EventHistory: { v1: "TransitionHistory", fields: { id: kept, trigger_id: kept, decision: kept, created_at: kept, version: kept }, added: ["writer"] },
  UnitDiagnostics: { v1: "ScopeDiagnostics", fields: { scope_id: to("unit_id"), scope_version: to("unit_version"), executions: to("attempts"),
    resources: removed(), effects: kept, cursor: removed() }, added: ["rejected"] },
  EffectDiagnostic: { v1: "EffectDiagnosticRecord", fields: { id: kept, effect_key: kept, status: kept, version: removed() },
    added: ["seq", "tries", "next_try_at", "last_error", "updated_at"] },
  ArtifactDetail: { v1: "ArtifactDetail", fields: { run_id: kept, scope_id: to("unit_id"), output_key: to("artifact_key"), collection_key: kept,
    slot_version: to("artifact_version"), revision_id: kept, predecessor_id: kept, body: kept, status: kept, presentation: removed("presentation_in_pwa") },
    added: ["schema", "reviewable", "revisions", "decisions"] },
  SessionLocation: { v1: "SessionLocation", fields: { run_id: kept, scope_id: to("unit_id"), execution_id: to("attempt_id") }, added: [] },
  RunSessionAttempt: { v1: "RunSessionAttempt", fields: { location: kept, worker_key: kept, generation: kept, status: kept, result: kept }, added: [] },
  RunEvent: { v1: "RunEvent", fields: { transition_id: to("event_id"), run_id: kept, scope_id: to("unit_id"), scope_key: to("unit_key"), decision: kept,
    attention: kept, is_terminal: kept, occurred_at: kept }, added: ["kind", "run_status"] },
  DefinitionSummary: { v1: "DefinitionSummary", fields: { bundle_id: kept, digest: kept, source: kept, archived_at: kept }, added: [] },
  PinnedDefinition: { v1: "PinnedDefinition", fields: { bundle_id: kept, digest: kept, source: kept, archived_at: kept, checked_program: kept }, added: [] },
  DefinitionDetail: { v1: "DefinitionDetail", fields: { bundle_id: kept, digest: kept, source: kept, archived_at: kept, graph: kept,
    authoring: removed("no_authoring") }, added: [] },
  DefinitionBundle: { v1: "DefinitionBundle", fields: { key: kept, version: kept, root: kept, schemas: kept, scopes: to("units"),
    language_version: removed(), limits: removed(), operations: removed(), prompts: removed() }, added: [] },
  UnitDefinition: { v1: "ScopeDefinition", fields: { key: kept, input_schema: kept, presentation: kept, outputs: to("artifacts"),
    cancellation: removed(), children: removed(), commands: removed(), entry_command: removed(), entry_payload: removed(), errors: removed(),
    exports: removed(), facts: removed(), initial: removed(), outcome_schema: removed(), pools: removed(), resources: removed(),
    state_schema: removed(), tree: removed(), workers: removed() }, added: [] },
  ArtifactDefinition: { v1: "OutputDefinition", fields: { key: kept, schema: kept, collection_key: kept, edit_trigger: kept, policy: removed(),
    producers: removed(), publication_trigger: removed() }, added: [] },
  Schema: { v1: "Schema", fields: { key: kept, shape: kept }, added: [] },
  Presentation: { v1: "Presentation", fields: { label: kept, viewer: removed() }, added: [] },
  DecisionFieldPresentation: { v1: "CommandFieldPresentation", fields: { key: kept, presentation: kept }, added: [] },
  TargetRevision: { v1: "TargetRevision", fields: { identity: kept, version: kept }, added: [] },
  AttentionMetadata: { v1: "AttentionMetadata", fields: { label: kept, trigger: kept }, added: [] },
} as const satisfies Readonly<Record<string, ReadModelPort>>;
export type ReadModelName = keyof typeof PORT_MAP;

/** The v2 field names a read model must carry, exactly. */
export function expectedFields(model: ReadModelName): readonly string[] {
  const port: ReadModelPort = PORT_MAP[model];
  const carried = Object.entries(port.fields).flatMap(([name, fate]) => fate.kind === "kept" ? [name] : fate.kind === "renamed" ? [fate.to] : []);
  return [...carried, ...port.added].sort();
}
