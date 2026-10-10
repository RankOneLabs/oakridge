import type {
  OperatorArtifactDetail, OperatorDecision, OperatorReviewInbox, OperatorRunDetail,
  OperatorRunSessionAttempt, OperatorRunSummary, OperatorSessionLocation,
} from "../operator-contracts";

/** Shared defaults for operator read-model tests; callers override only the behavior under test. */
export function makeRunSummary(overrides: Partial<OperatorRunSummary> = {}): OperatorRunSummary {
  return { run_id: "run-1", definition_bundle_id: "bundle-1", definition_digest: "digest-1",
    version: 1, created_at: "2026-01-01T00:00:00.000Z", archived_at: null, ...overrides };
}

export function makeRunDetail(overrides: Partial<OperatorRunDetail> = {}): OperatorRunDetail {
  return { ...makeRunSummary(), cursor: [], scopes: [], ...overrides };
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

export function makeDecision(overrides: Partial<OperatorDecision> = {}): OperatorDecision {
  return { decision: null, cursor: { scope_version: 1, transition_id: null }, ...overrides };
}

export function makeReviewInbox(overrides: Partial<OperatorReviewInbox> = {}): OperatorReviewInbox {
  return { cursor: [], items: [], next_cursor: null, ...overrides };
}
