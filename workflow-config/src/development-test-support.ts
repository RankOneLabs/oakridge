import type { AssignmentVerification, FeedbackProposal } from "../../oakridge-dbos/src/core-client/core-types";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import YAML from "yaml";
import { expandIncludes } from "./workflow-include";
import { CoreClient, compileWorkflow } from "../../oakridge-dbos/src/core-client/client";
import type { Event, StepResult, StepSnapshot, WantedWorker } from "../../oakridge-dbos/src/core-client/core-types";
import { decodeWorkflowSource } from "../../oakridge-dbos/src/core-client/source-types";
import type { AuthoredWorkflow } from "./definition-objects";
import { referencedPromptPaths } from "./definition-objects";
import { expandPrompts } from "../../oakridge-dbos/src/runtime/prompt-includes";

export const root = resolve(import.meta.dir, "../..");
export function readAuthoredWorkflow(name: string): AuthoredWorkflow {
  const document = YAML.parseDocument(readFileSync(resolve(root, "workflow-config", `${name}.yaml`), "utf8"));
  const expanded = expandIncludes(document, (path) =>
    YAML.parseDocument(readFileSync(resolve(root, "workflow-config", path), "utf8")));
  if (!expanded.ok) throw new Error(expanded.error.detail);
  const workflow = decodeWorkflowSource(expanded.value.toJS());
  if (!workflow) throw new Error(`Invalid ${name} workflow source`);
  return workflow;
}
export const development = readAuthoredWorkflow("development");
const promptRoot = resolve(root, "workflow-config/prompts");
const authoredPrompts = Object.fromEntries(readdirSync(promptRoot, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
  const path = resolve(entry.parentPath, entry.name);
  return [relative(promptRoot, path).split(sep).join("/"), readFileSync(path, "utf8")];
}));
/** A workflow's prompts as a session receives them: authored, with every include expanded. */
export function expandedPrompts(workflow: AuthoredWorkflow): Readonly<Record<string, string>> {
  const expanded = expandPrompts(referencedPromptPaths(workflow), authoredPrompts);
  if (!expanded.ok) throw new Error(expanded.error.detail);
  return expanded.value.prompts;
}
export const prompts = expandedPrompts(development);
const started = CoreClient.start();
if (!started.ok) throw new Error(JSON.stringify(started.error));
export const core = started.value;

export function stageWorkflow(stage: string): AuthoredWorkflow {
  const input = development.stages[stage].input;
  if (typeof input === "string") throw new Error("Expected record stage input");
  return { ...development, label: undefined, input, run: { units: { unit: { stage, input: Object.fromEntries(Object.keys(input).map(key => [key, `input.${key}`])) } }, outcome: {} } };
}

export class TestRun {
  private readonly observedWanted = new Map<string, WantedWorker>();
  private constructor(readonly digest: string, public result: StepResult) {}
  static async launch(workflow: AuthoredWorkflow, input: unknown): Promise<TestRun> {
    const compiled = await compileWorkflow(core, { workflow, prompts });
    if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
    const snapshot: StepSnapshot = { run: { id: "run", root: "run" }, units: [], attempts: [], revisions: [], decisions: [], retry_events: [] };
    const run = new TestRun(compiled.value.digest, { snapshot, wanted: [], reviews: [], blocked: [] });
    await run.apply({ kind: "launched", input });
    return run;
  }
  async apply(event: Event): Promise<void> {
    const result = await core.request("step", { workflow_digest: this.digest, snapshot: this.result.snapshot, incoming: { event, writer: { kind: "engine" } } });
    if (!result.ok) throw new Error(JSON.stringify(result.error));
    if (result.value.kind !== "stepped") throw new Error("Expected step result");
    this.result = result.value.value;
    for (const wanted of this.result.wanted) this.observedWanted.set(wanted.action_id, wanted);
  }
  latest(artifact: string, unit = "run/unit") {
    const revision = this.result.snapshot.revisions.filter(r => r.unit === unit && r.artifact === artifact).at(-1);
    if (!revision) throw new Error(`Missing ${unit}.${artifact}`);
    return revision;
  }
  activeWanted(): WantedWorker[] {
    return [...this.observedWanted.values()].filter(w => this.result.snapshot.attempts.some(a => a.action_id === w.action_id && (a.status.kind === "pending" || a.status.kind === "running")));
  }
  wanted(worker: string, unit = "run/unit") {
    const wanted = this.activeWanted().find(w => w.worker === worker && w.unit === unit);
    if (!wanted) throw new Error(`Missing wanted ${unit}.${worker}`);
    return wanted;
  }
  async publish(worker: string, artifact: string, body: unknown, unit = "run/unit"): Promise<void> {
    const attempt = this.result.snapshot.attempts.filter(a => a.unit === unit && a.worker === worker).at(-1);
    if (!attempt) throw new Error(`Missing attempt ${worker}`);
    const previous = this.result.snapshot.revisions.filter(r => r.unit === unit && r.artifact === artifact).at(-1);
    const subject = worker === "assessor" ? this.latest("build_result", unit).id : null;
    await this.apply({ kind: "revision_published", unit, artifact, body, by: { action: attempt.action_id, seq: attempt.seq }, predecessor: previous?.id ?? null, subject });
  }
  async end(worker: string, unit = "run/unit"): Promise<void> {
    const attempt = this.result.snapshot.attempts.filter(a => a.unit === unit && a.worker === worker).at(-1);
    if (!attempt) throw new Error(`Missing attempt ${worker}`);
    await this.apply({ kind: "worker_ended", action: attempt.action_id, result: { kind: "succeeded" } });
  }
  async decide(review: string, decision: string, artifact: string, payload: unknown = {}, unit = "run/unit"): Promise<void> {
    await this.apply({ kind: "operator_decided", unit, review, decision, target: this.result.reviews.find(r => r.unit === unit && r.review === review)?.decisions.find(d => d.decision === decision)?.target ?? this.latest(artifact, unit).id, payload });
  }
}

export const workspace = { checkout_root: "/tmp/oakridge-contract", push_remote_owner: "owner", head: "head", checkout_branch: "base" };
export const repository = { key: "oakridge", preparation: { checkout_root: workspace.checkout_root, expected_head: null }, forge: { namespace: "owner", path: "oakridge", build_base: "base", final_base: "main" } };
export interface Resolution { kind: "implementation_note" | "operator_decision" | "spec_update"; text: string; decision_prompt?: string; alternatives?: {option: string; consequence: string}[]; chosen?: string }
export interface Finding { id: string; finding_impact: "blocking" | "warning" | "info"; finding_note: string; supporting_citations: {kind: "file"; citation_location: string; detail: string}[]; expected_change_locations: {path: string}[]; finding_resolution?: Resolution }
export interface AnalysisRequirement { id: string; text: string; source_refs: string[]; findings: Finding[] }
export interface AnalysisBody { requirements: AnalysisRequirement[] }
export interface SpecRequirement { id: string; text: string; source_refs: string[]; acceptance_conditions: string[]; analysis_finding_ids: string[] }
export interface SpecBody { objective: string; requirements: SpecRequirement[]; non_goals: string[] }
export interface PlanCohort { id: string; assigned_repository: string; title: string; change_scope: string; allocations: {requirement_id: string; contribution: string}[]; prerequisite_cohorts: string[]; decision_reason: string }
export interface BriefBody { cohort_id: string; assigned_repository: string; prerequisite_cohorts: string[]; files_in_scope: string[]; build_items: {id: string; requirement_ids: string[]; instructions: string; verification: string[]}[]; technical_decisions: {id: string; build_item_ids: string[]; decision: string; decision_reason: string}[] }
export interface EvidenceRef { kind: "file" | "test" | "output"; citation_location: string; detail?: string }
export interface TestEvidence { passed: number; failing_tests: number; output?: string; test_notes?: string; cargo_test_output?: string }
export interface AssessmentBody { head_sha: string; item_assessments: {subject: {kind: "build_item" | "requirement"; id: string}; status: "met" | "partial" | "not_met"; finding_note: string; supporting_citations: EvidenceRef[]}[]; additional_findings: {id: string; finding_impact: "blocking" | "warning" | "info"; finding_note: string; related_build_item_ids: string[]; supporting_citations: EvidenceRef[]}[]; proposals: FeedbackProposal[]; verifications: AssignmentVerification[]; test_evidence: TestEvidence; verdict: "pass" | "pass_with_notes" | "fail" }
export function analysis(): AnalysisBody { return { requirements: ["R1", "R2"].map((id, index) => ({ id, text: id, source_refs: [`spec:${id}`], findings: [{ id: `F${index+1}`, finding_impact: "info", finding_note: "Implementable", supporting_citations: [{kind: "file", citation_location: "README.md", detail: "Existing architecture"}], expected_change_locations: [], finding_resolution: {kind: "implementation_note", text: "Use existing patterns"} }] })) }; }
export function spec(): SpecBody { return {objective: "Objective", requirements: analysis().requirements.map(r => ({id: r.id, text: r.text, source_refs: r.source_refs, acceptance_conditions: ["Observable result"], analysis_finding_ids: r.findings.map(f => f.id)})), non_goals: []}; }
export function cohort(id = "C1", ids = ["R1", "R2"], prerequisite_cohorts: string[] = []): PlanCohort { return {id, assigned_repository: "oakridge", title: id, change_scope: "Scope", allocations: ids.map(requirement_id => ({requirement_id, contribution: `${id} contribution`})), prerequisite_cohorts, decision_reason: "Reviewable"}; }
export function brief(c = cohort()): BriefBody { return {cohort_id: c.id, assigned_repository: c.assigned_repository, prerequisite_cohorts: c.prerequisite_cohorts, files_in_scope: [], build_items: c.allocations.map((a, i) => ({id: `B${i+1}`, requirement_ids: [a.requirement_id], instructions: a.contribution, verification: ["Verify behavior"]})), technical_decisions: [{id: "D1", build_item_ids: ["B1"], decision: "Existing pattern", decision_reason: "Precedent"}]}; }
export function assessment(kind: "build_item" | "requirement" = "build_item"): AssessmentBody { return {head_sha: "sha", item_assessments: (kind === "build_item" ? ["B1", "B2"] : ["R1", "R2"]).map(id => ({subject: {kind, id}, status: "met", finding_note: "Verified", supporting_citations: []})), additional_findings: [], proposals: [], verifications: [], test_evidence: {passed: 1, failing_tests: 0}, verdict: "pass"}; }
export const buildResult = {committed_revision: "sha", change_overview: "Built", changed_files: [], tests: {passed: 1, failing_tests: 0}, delivery_issues: []};
export const pr = {change_request_link: "https://example.com/pr/1", source_branch: "feature", change_overview: "Change", review_status: "draft"};
export function validationFeedback(run: TestRun): string { return JSON.stringify(run.result.snapshot.decisions); }
