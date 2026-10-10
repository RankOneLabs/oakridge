import type {
  OperatorArtifactDetail, OperatorArtifactRevisionRecord, OperatorCommandDefinition, OperatorDecision,
  OperatorOutputSlotView, OperatorReviewInbox, OperatorRunDetail,
  OperatorRunSessionAttempt, OperatorRunSummary, OperatorSessionLocation, OperatorScopeView,
} from "../operator-contracts";

/** Shared defaults for operator read-model tests; callers override only the behavior under test. */
export function makeRunSummary(overrides: Partial<OperatorRunSummary> = {}): OperatorRunSummary {
  return { run_id: "run-1", definition_bundle_id: "bundle-1", definition_digest: "digest-1",
    version: 1, created_at: "2026-01-01T00:00:00.000Z", archived_at: null, ...overrides };
}

export function makeRunDetail(overrides: Partial<OperatorRunDetail> = {}): OperatorRunDetail {
  return { ...makeRunSummary(), cursor: [], scopes: [], ...overrides };
}

export function makeScopeView(overrides: Partial<OperatorScopeView> = {}): OperatorScopeView {
  return { run_id: "run-1", scope_id: "scope-1", scope_key: "development", label: "Development",
    state: { schema: "text", data: { kind: "string", value: "running" } }, outcome: null,
    is_terminal: false, commands: [], executions: [], outputs: [], resources: [],
    command_targets: {}, command_prefill: {}, decision: null,
    cursor: { scope_version: 1, transition_id: null }, ...overrides };
}

export function makeSessionLocation(overrides: Partial<OperatorSessionLocation> = {}): OperatorSessionLocation {
  return { run_id: "run-1", scope_id: "scope-1", execution_id: "execution-1", ...overrides };
}

export function makeRunSessionAttempt(overrides: Partial<OperatorRunSessionAttempt> = {}): OperatorRunSessionAttempt {
  return { location: makeSessionLocation(), worker_key: "author", generation: 1,
    status: "pending", result: null, ...overrides };
}

export function makeArtifactDetail(overrides: Partial<OperatorArtifactDetail> = {}): OperatorArtifactDetail {
  const emptyList = (schema: string) => ({ schema, data: { kind: "list" as const, items: [] } });
  return { run_id: "run-1", scope_id: "scope-1", output_key: "analysis", collection_key: "",
    slot_version: 1, revision_id: "revision-1", predecessor_id: null,
    body: { schema: "analysis_body", data: { kind: "record", fields: [
      { field_id: 0, value: { schema: "text", data: { kind: "string", value: "Draft" } } },
      { field_id: 1, value: emptyList("texts") },
      { field_id: 2, value: emptyList("spec_findings") },
      { field_id: 3, value: emptyList("requirements") },
      { field_id: 4, value: emptyList("risks") },
    ], dictionary: [] } }, status: "draft",
    presentation: { artifact_type: "analysis", viewer: "document",
      capabilities: { reviewable: true, commentable: true, atom_editable: true, review_items: true } },
    ...overrides };
}

export function makeArtifactRevision(overrides: Partial<OperatorArtifactRevisionRecord> = {}): OperatorArtifactRevisionRecord {
  return { id: "revision-1", run_id: "run-1", scope_id: "scope-1", execution_id: "execution-1",
    output_key: "analysis", collection_key: "", version: 1, predecessor_id: null,
    created_at: "2026-07-01T09:00:00Z", body: { schema: "text", data: { kind: "string", value: "Spec body" } },
    ...overrides };
}

export function makeOutputSlot(overrides: Partial<OperatorOutputSlotView> = {}): OperatorOutputSlotView {
  const revision = makeArtifactRevision();
  return { id: "slot-1", run_id: "run-1", scope_id: "scope-1", output_key: "analysis",
    collection_key: "", current_revision_id: revision.id, current_revision: revision, version: 1, ...overrides };
}

export function makeCommand(overrides: Partial<OperatorCommandDefinition> = {}): OperatorCommandDefinition {
  return { key: "approve", label: "Approve", consequence: "Approve the current revision",
    payload_schema: "text", available_in: ["running"], required: false, field_presentation: [],
    targets: [{ kind: "reference", root: { kind: "output", key: "analysis" }, path: [] }], ...overrides };
}

export function makeDecision(overrides: Partial<OperatorDecision> = {}): OperatorDecision {
  return { decision: null, cursor: { scope_version: 1, transition_id: null }, ...overrides };
}

export function makeReviewInbox(overrides: Partial<OperatorReviewInbox> = {}): OperatorReviewInbox {
  return { cursor: [], items: [], next_cursor: null, ...overrides };
}
