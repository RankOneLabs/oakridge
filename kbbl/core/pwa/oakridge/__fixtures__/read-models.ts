import type {
  OperatorArtifactDetail, OperatorArtifactRevisionRecord, OperatorCheckedValue, OperatorCommandDefinition, OperatorDecision,
  OperatorInboxItem, OperatorOutputSlotView, OperatorProjectDraft, OperatorProjectView, OperatorReviewInbox, OperatorRunDetail,
  OperatorRunSessionAttempt, OperatorRunSummary, OperatorSchema, OperatorSessionLocation, OperatorScopeView,
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

export function makeInboxCommand(overrides: Partial<Extract<OperatorInboxItem, { kind: "command" }>> = {}): Extract<OperatorInboxItem, { kind: "command" }> {
  return { kind: "command", run_id: "run-1", scope_id: "scope-1", scope_version: 1,
    key: "approve", label: "Approve", consequence: "Approve the current revision", ...overrides };
}

export function makeInboxWait(overrides: Partial<Extract<OperatorInboxItem, { kind: "wait" }>> = {}): Extract<OperatorInboxItem, { kind: "wait" }> {
  return { kind: "wait", run_id: "run-1", scope_id: "scope-1", scope_version: 1,
    reason: "handoff_downstream", label: "Waiting for build", ...overrides };
}

export function makeInboxDiagnostic(overrides: Partial<Extract<OperatorInboxItem, { kind: "diagnostic" }>> = {}): Extract<OperatorInboxItem, { kind: "diagnostic" }> {
  return { kind: "diagnostic", run_id: "run-1", scope_id: "scope-1", scope_version: 1,
    detail: "pull request mismatch", ...overrides };
}

export function makeProject(overrides: Partial<OperatorProjectView> = {}): OperatorProjectView {
  return { id: "project-1", name: "Scout", repo_dir: "/code/rol/scout", created_at: "2026-08-15T12:00:00Z",
    forge_repository: { provider: "github", owner: "RankOneLabs", name: "scout" },
    integration_branch: "main", session_policy: null, ...overrides };
}

export function makeProjectDraft(overrides: Partial<OperatorProjectDraft> = {}): OperatorProjectDraft {
  return { name: "Scout", repo_dir: "/code/rol/scout", forge_repository: null,
    integration_branch: null, ...overrides };
}

interface PlanCohortInput { readonly id: string; readonly title: string; readonly depends_on: readonly string[] }
export interface PlanGraphFixture { readonly body: OperatorCheckedValue; readonly schemas: readonly OperatorSchema[] }

/** Field order mirrors plan_body, plan_cohort and plan_scope in workflow-config/definitions/development.json. */
export function makePlanGraphFixture(cohorts: readonly PlanCohortInput[], dependencyOrder: readonly string[] = cohorts.map((cohort) => cohort.id)): PlanGraphFixture {
  const value = (schema: string, text: string): OperatorCheckedValue => ({ schema, data: { kind: "string", value: text } });
  const list = (schema: string, items: readonly OperatorCheckedValue[]): OperatorCheckedValue =>
    ({ schema, data: { kind: "list", items: [...items] } });
  const record = (schema: string, fields: readonly OperatorCheckedValue[]): OperatorCheckedValue =>
    ({ schema, data: { kind: "record", fields: fields.map((field, field_id) => ({ field_id, value: field })), dictionary: [] } });
  const emptyOptional = (schema: string): OperatorCheckedValue => ({ schema, data: { kind: "optional", value: null } });
  const checkedCohorts = cohorts.map((cohort) => record("plan_cohort", [
    value("ident", cohort.id), emptyOptional("optional_ident"), value("text", cohort.title), value("text", "One package."),
    list("ids", cohort.depends_on.map((id) => value("ident", id))), emptyOptional("optional_text"),
    list("texts", []), list("texts", []), list("texts", []),
  ]));
  const body = record("plan_body", [value("text", "Two cohorts."), list("plan_cohorts", checkedCohorts),
    list("ids", dependencyOrder.map((id) => value("ident", id))), record("plan_scope", [list("texts", []), list("texts", [])]),
    list("texts", []), list("risks", [])]);
  const field = (key: string, schema: string) => ({ key, schema, required: true });
  const schemas: readonly OperatorSchema[] = [
    { key: "plan_body", shape: { kind: "record", fields: [field("summary", "text"), field("cohorts", "plan_cohorts"),
      field("dependency_order", "ids"), field("scope", "plan_scope"), field("acceptance_criteria", "texts"), field("risks", "risks")], dictionary: null } },
    { key: "plan_cohort", shape: { kind: "record", fields: [field("id", "ident"), field("repository_key", "optional_ident"),
      field("title", "text"), field("scope", "text"), field("depends_on", "ids"), field("description", "optional_text"),
      field("files_in_scope", "texts"), field("decisions", "texts"), field("acceptance_criteria", "texts")], dictionary: null } },
    { key: "plan_scope", shape: { kind: "record", fields: [field("in_scope", "texts"), field("out_of_scope", "texts")], dictionary: null } },
  ];
  return { body, schemas };
}
