import type {
  OperatorArtifactDetail, OperatorArtifactRevisionRecord, OperatorCheckedValue, OperatorCommandDefinition, OperatorDecision,
  OperatorInboxItem, OperatorOutputSlotView, OperatorProjectDraft, OperatorProjectView, OperatorReviewInbox, OperatorRunDetail,
  OperatorRunSessionAttempt, OperatorRunSummary, OperatorSchema, OperatorSessionLocation, OperatorScopeView,
  OperatorRunEvent, OperatorDefinitionSummary, OperatorExecutionView, OperatorCommandReceipt,
  OperatorStartPinnedRunRequest, OperatorStartedRun,
} from "../operator-contracts";
import developmentDefinition from "../../../../../workflow-config/definitions/development.json";
import type { OperatorCommandSubmission } from "../lib/operator-drafts";
import type { OakridgeConfig } from "../types";
import type { RuntimeDescriptor, RuntimeModelSelection } from "../../types";

/** Materialize test bodies from the same pinned schema that the compiler checks. */
const developmentSchemas: readonly OperatorSchema[] = developmentDefinition.schemas as unknown as readonly OperatorSchema[];

function checkedFixtureValue(schemaKey: string, input: unknown): OperatorCheckedValue {
  const shape = developmentSchemas.find((schema) => schema.key === schemaKey)?.shape;
  if (!shape) throw new Error(`Missing development schema ${schemaKey}`);
  if (shape.kind === "string") {
    if (typeof input !== "string") throw new Error(`${schemaKey} must be text`);
    return { schema: schemaKey, data: { kind: "string", value: input } };
  }
  if (shape.kind === "integer") {
    if (typeof input !== "number" || !Number.isInteger(input)) throw new Error(`${schemaKey} must be an integer`);
    return { schema: schemaKey, data: { kind: "integer", value: input } };
  }
  if (shape.kind === "boolean") {
    if (typeof input !== "boolean") throw new Error(`${schemaKey} must be boolean`);
    return { schema: schemaKey, data: { kind: "boolean", value: input } };
  }
  if (shape.kind === "enum") {
    if (typeof input !== "string" || !shape.variants.includes(input)) throw new Error(`${schemaKey} has an unknown variant`);
    return { schema: schemaKey, data: { kind: "enum", variant: input } };
  }
  if (shape.kind === "list") {
    if (!Array.isArray(input)) throw new Error(`${schemaKey} must be a list`);
    return { schema: schemaKey, data: { kind: "list", items: input.map((item) => checkedFixtureValue(shape.item, item)) } };
  }
  if (shape.kind === "optional") {
    return { schema: schemaKey, data: { kind: "optional", value: input == null ? null : checkedFixtureValue(shape.item, input) } };
  }
  if (shape.kind === "record") {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw new Error(`${schemaKey} must be a record`);
    const record = input as Readonly<{ [key: string]: unknown }>;
    return { schema: schemaKey, data: { kind: "record", fields: shape.fields.map((field, field_id) => {
      if (!(field.key in record)) throw new Error(`${schemaKey}.${field.key} is missing`);
      return { field_id, value: checkedFixtureValue(field.schema, record[field.key]) };
    }), dictionary: [] } };
  }
  throw new Error(`No fixture materializer for ${schemaKey} (${shape.kind})`);
}

export interface CheckedArtifactFixture { readonly body: OperatorCheckedValue; readonly schemas: readonly OperatorSchema[] }

function developmentFixture(schemaKey: string, input: unknown): CheckedArtifactFixture {
  return { body: checkedFixtureValue(schemaKey, input), schemas: developmentSchemas };
}

interface SpecFindingInput { readonly id: string; readonly description: string; readonly severity: "blocking" | "warning" | "info" }
interface RequirementInput { readonly id: string; readonly description: string; readonly status: "blocked" | "ambiguous" | "implementable" }
interface RiskInput { readonly description: string; readonly mitigation: string }
interface SpecAnalysisInput { readonly summary: string; readonly source_spec_refs: readonly string[]; readonly findings: readonly SpecFindingInput[];
  readonly requirements: readonly RequirementInput[]; readonly risks: readonly RiskInput[] }

export function makeSpecAnalysisFixture(overrides: Partial<SpecAnalysisInput> = {}): CheckedArtifactFixture {
  return developmentFixture("analysis_body", { summary: "The brief is mostly implementable.", source_spec_refs: ["Brief §2"],
    findings: [{ id: "f1", description: "Schema conflict", severity: "blocking" },
      { id: "f2", description: "Naming drift", severity: "warning" }],
    requirements: [{ id: "r1", description: "Needs upstream API", status: "blocked" },
      { id: "r2", description: "Add the column", status: "implementable" }],
    risks: [{ description: "Migration locks the table", mitigation: "Backfill in batches" }], ...overrides });
}

interface BriefDecisionInput { readonly decision: string; readonly rationale: string }
interface RejectedApproachInput { readonly approach: string; readonly reason: string }
interface BuildBriefInput { readonly cohort_id: string; readonly repository_key: string; readonly title: string;
  readonly depends_on: readonly string[]; readonly goal: string; readonly files_in_scope: readonly string[];
  readonly decisions_made: readonly BriefDecisionInput[]; readonly approaches_rejected: readonly RejectedApproachInput[];
  readonly acceptance_criteria: readonly string[]; readonly next_action: string }

export function makeBuildBriefFixture(overrides: Partial<BuildBriefInput> = {}): CheckedArtifactFixture {
  return developmentFixture("brief_body", { cohort_id: "brief-ui", repository_key: "oakridge", title: "Build brief review UI",
    depends_on: [], goal: "Make the brief reviewable.", files_in_scope: ["kbbl/core/pwa/oakridge"],
    decisions_made: [{ decision: "Reuse v1", rationale: "It is proven." }], approaches_rejected: [],
    acceptance_criteria: ["Operator can approve the artifact."], next_action: "Open the brief artifact.", ...overrides });
}

interface TestEvidenceInput { readonly passed: number; readonly failed: number; readonly output: string | null;
  readonly summary: string | null; readonly cargo_test_output: string | null }
interface BuildMetadataInput { readonly cohort_id: string; readonly session_id: string | null; readonly branch: string | null }
interface BuildIssueInput { readonly severity: "blocking" | "warning" | "info"; readonly description: string }
interface BuildResultInput { readonly repository_key: string | null; readonly summary: string; readonly changed_files: readonly string[];
  readonly tests: TestEvidenceInput; readonly delegated_session_metadata: BuildMetadataInput | null;
  readonly known_issues: readonly BuildIssueInput[] }

export function makeBuildResultFixture(overrides: Partial<BuildResultInput> = {}): CheckedArtifactFixture {
  return developmentFixture("build_body", { repository_key: "assay", summary: "Built the API.",
    changed_files: ["src/api.py", "ci.yml"], tests: { passed: 78, failed: 0, output: "78 passed", summary: null, cargo_test_output: null },
    delegated_session_metadata: { cohort_id: "cm-api", session_id: null, branch: null },
    known_issues: [{ severity: "blocking", description: "Fixture table incomplete." }], ...overrides });
}

interface AssessmentFindingInput { readonly criterion: string | null; readonly status: "met" | "not_met" | "partial" | null;
  readonly evidence: string | null; readonly description: string | null }
interface AssessmentInput { readonly verdict: "pass" | "pass_with_notes" | "fail";
  readonly findings: readonly AssessmentFindingInput[]; readonly test_evidence: TestEvidenceInput | null;
  readonly recommended_next_actions: readonly string[] }

export function makeAssessmentFixture(overrides: Partial<AssessmentInput> = {}): CheckedArtifactFixture {
  return developmentFixture("assessment_body", { verdict: "fail",
    findings: [{ criterion: "The CLI prints JSON.", status: "met", evidence: "Snapshot test passes.", description: null },
      { criterion: "Every fixture exists.", status: "not_met", evidence: "B, E, F and G are missing.", description: null }],
    test_evidence: { passed: 1274, failed: 0, output: null, summary: "Independently re-run.", cargo_test_output: null },
    recommended_next_actions: ["Supply the missing fixtures."], ...overrides });
}

/** Shared defaults for operator read-model tests; callers override only the behavior under test. */
export function makeRunSummary(overrides: Partial<OperatorRunSummary> = {}): OperatorRunSummary {
  return { run_id: "run-1", definition_bundle_id: "bundle-1", definition_digest: "digest-1",
    version: 1, created_at: "2026-01-01T00:00:00.000Z", archived_at: null, ...overrides };
}

export function makeRunDetail(overrides: Partial<OperatorRunDetail> = {}): OperatorRunDetail {
  return { ...makeRunSummary(), cursor: [], scopes: [], ...overrides };
}

export function makeDefinitionSummary(overrides: Partial<OperatorDefinitionSummary> = {}): OperatorDefinitionSummary {
  return { bundle_id: "bundle-1", digest: "digest-1", source: developmentDefinition as unknown as OperatorDefinitionSummary["source"],
    archived_at: null, ...overrides };
}

export function makeStartPinnedRunRequest(overrides: Partial<OperatorStartPinnedRunRequest> = {}): OperatorStartPinnedRunRequest {
  return { digest: "digest-1", input: { project_id: "project-1" }, request_id: "launch-1", ...overrides };
}

export function makeStartedRun(overrides: Partial<OperatorStartedRun> = {}): OperatorStartedRun {
  return { run_id: "run-1", root_scope_id: "scope-1", bundle_id: "bundle-1", ...overrides };
}

export function makeCommandSubmission(overrides: Partial<OperatorCommandSubmission> = {}): OperatorCommandSubmission {
  return { run_id: "run-1", scope_id: "scope-1", command_key: "approve", owner_version: 1,
    targets: [], request_id: "request-1", payload: {}, ...overrides };
}

export function makeCommandReceipt(overrides: Partial<OperatorCommandReceipt> = {}): OperatorCommandReceipt {
  return { kind: "accepted_pending", request_id: "request-1", transition_id: "transition-1", scope_version: 2, ...overrides };
}

export function makeOakridgeConfig(overrides: Partial<OakridgeConfig> = {}): OakridgeConfig {
  return { available: true, core_url: "http://oakridge.test", fallback_refresh_ms: 5_000, ...overrides };
}

export function makeRuntimeDescriptor(overrides: Partial<RuntimeDescriptor> = {}): RuntimeDescriptor {
  return { id: "claude-code", label: "Claude Code", models: [{ value: "claude-opus-4-8", label: "opus 4.8" }],
    efforts: [{ value: "medium", label: "medium" }, { value: "high", label: "high" }],
    supportsCompaction: true, ...overrides };
}

export function makeRuntimeSelection(overrides: Partial<RuntimeModelSelection> = {}): RuntimeModelSelection {
  return { runtime: "claude-code", model: "claude-opus-4-8", effort: undefined, ...overrides };
}

export function makeExecutionView(overrides: Partial<OperatorExecutionView> = {}): OperatorExecutionView {
  return { id: "execution-1", scope_id: "scope-1", worker_key: "author", generation: 1,
    status: "pending", result: null, version: 1, ...overrides };
}

export function makeRunEvent(overrides: Partial<OperatorRunEvent> = {}): OperatorRunEvent {
  return { transition_id: "transition-1", run_id: "run-one", scope_id: "scope-one", scope_key: "spec_analysis",
    decision: "wait", attention: { label: "Awaiting work or review", trigger: "accept" }, is_terminal: false,
    occurred_at: "2026-10-09T00:00:00.000Z", ...overrides };
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

export interface PrSummaryFixture { readonly body: OperatorCheckedValue; readonly schemas: readonly OperatorSchema[] }

/** The field order and optional status mirror pr_body in the shipped development definition. */
export function makePrSummaryFixture(overrides: { readonly pr_url?: string; readonly branch?: string;
  readonly summary?: string; readonly review_status?: string | null } = {}): PrSummaryFixture {
  const value = (schema: string, text: string): OperatorCheckedValue => ({ schema, data: { kind: "string", value: text } });
  const body: OperatorCheckedValue = { schema: "pr_body", data: { kind: "record", fields: [
    { field_id: 0, value: value("text", overrides.pr_url ?? "https://github.com/RankOneLabs/assay/pull/50") },
    { field_id: 1, value: value("ident", overrides.branch ?? "cohort/run/cm-api") },
    { field_id: 2, value: value("text", overrides.summary ?? "Adds analyze().") },
    { field_id: 3, value: { schema: "optional_pr_review_status", data: { kind: "optional", value: overrides.review_status
      ? { schema: "pr_review_status", data: { kind: "enum", variant: overrides.review_status } } : null } } },
  ], dictionary: [] } };
  const schemas: readonly OperatorSchema[] = [{ key: "pr_body", shape: { kind: "record", fields: [
    { key: "pr_url", schema: "text", required: true }, { key: "branch", schema: "ident", required: true },
    { key: "summary", schema: "text", required: true }, { key: "review_status", schema: "optional_pr_review_status", required: true },
  ], dictionary: null } }];
  return { body, schemas };
}

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
