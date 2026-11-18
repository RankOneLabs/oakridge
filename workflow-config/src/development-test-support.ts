import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import YAML from "yaml";
import { CoreClient, compileWorkflow } from "../../oakridge-dbos/src/core-client/client";
import type { Event, StepResult, StepSnapshot, WantedWorker } from "../../oakridge-dbos/src/core-client/core-types";
import { decodeWorkflowSource } from "../../oakridge-dbos/src/core-client/source-types";
import type { AuthoredWorkflow } from "./definition-objects";
import { referencedPromptPaths } from "./definition-objects";

export const root = resolve(import.meta.dir, "../..");
const decoded = decodeWorkflowSource(YAML.parse(readFileSync(resolve(root, "workflow-config/development.yaml"), "utf8")));
if (!decoded) throw new Error("Invalid development source");
export const development = decoded;
export const prompts = Object.fromEntries(referencedPromptPaths(development).map(path => [path, readFileSync(resolve(root, "workflow-config/prompts", path), "utf8")]));
const started = CoreClient.start();
if (!started.ok) throw new Error(JSON.stringify(started.error));
export const core = started.value;

export function stageWorkflow(stage: string): AuthoredWorkflow {
  const input = development.stages[stage].input;
  if (typeof input === "string") throw new Error("Expected record stage input");
  return { ...development, input, run: { units: { unit: { stage, input: Object.fromEntries(Object.keys(input).map(key => [key, `input.${key}`])) } }, outcome: {} } };
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
    await this.apply({ kind: "revision_published", unit, artifact, body, by: attempt.action_id, predecessor: previous?.id ?? null, subject });
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

export const workspace = { repository_path: "/tmp/oakridge-contract", push_remote_owner: "owner", head: "head", base_branch: "base" };
export const repository = { key: "oakridge", preparation: { repository_path: workspace.repository_path, expected_head: null }, forge: { owner: "owner", name: "oakridge", build_base: "base", final_base: "main" } };
export interface Resolution { kind: "implementation_note" | "operator_decision" | "spec_update"; text: string; question?: string; alternatives?: {option: string; consequence: string}[]; chosen?: string }
export interface Finding { id: string; severity: "blocking" | "warning" | "info"; observation: string; evidence: {kind: "file"; ref: string; detail: string}[]; expected_change_locations: {path: string}[]; resolution?: Resolution }
export interface AnalysisRequirement { id: string; text: string; source_refs: string[]; findings: Finding[] }
export interface AnalysisBody { requirements: AnalysisRequirement[] }
export interface SpecRequirement { id: string; text: string; source_refs: string[]; acceptance_conditions: string[]; analysis_finding_ids: string[] }
export interface SpecBody { objective: string; requirements: SpecRequirement[]; non_goals: string[] }
export interface PlanCohort { id: string; repository_key: string; title: string; scope: string; allocations: {requirement_id: string; contribution: string}[]; depends_on: string[]; rationale: string }
export interface BriefBody { cohort_id: string; repository_key: string; depends_on: string[]; files_in_scope: string[]; build_items: {id: string; requirement_ids: string[]; instructions: string; verification: string[]}[]; technical_decisions: {id: string; build_item_ids: string[]; decision: string; rationale: string}[] }
export interface EvidenceRef { kind: "file" | "test" | "output"; ref: string; detail?: string }
export interface TestEvidence { passed: number; failed: number; output?: string; summary?: string; cargo_test_output?: string }
export interface AssessmentBody { head_sha: string; item_assessments: {subject: {kind: "build_item" | "requirement"; id: string}; status: "met" | "partial" | "not_met"; observation: string; evidence: EvidenceRef[]}[]; additional_findings: {id: string; severity: "blocking" | "warning" | "info"; observation: string; related_build_item_ids: string[]; evidence: EvidenceRef[]}[]; next_actions: {id?: string; audience: "builder" | "operator"; source: {kind: "item_assessment" | "additional_finding"; id: string}; text: string}[]; test_evidence: TestEvidence; verdict: "pass" | "pass_with_notes" | "fail" }
export function analysis(): AnalysisBody { return { requirements: ["R1", "R2"].map((id, index) => ({ id, text: id, source_refs: [`spec:${id}`], findings: [{ id: `F${index+1}`, severity: "info", observation: "Implementable", evidence: [{kind: "file", ref: "README.md", detail: "Existing architecture"}], expected_change_locations: [], resolution: {kind: "implementation_note", text: "Use existing patterns"} }] })) }; }
export function spec(): SpecBody { return {objective: "Objective", requirements: analysis().requirements.map(r => ({id: r.id, text: r.text, source_refs: r.source_refs, acceptance_conditions: ["Observable result"], analysis_finding_ids: r.findings.map(f => f.id)})), non_goals: []}; }
export function cohort(id = "C1", ids = ["R1", "R2"], depends_on: string[] = []): PlanCohort { return {id, repository_key: "oakridge", title: id, scope: "Scope", allocations: ids.map(requirement_id => ({requirement_id, contribution: `${id} contribution`})), depends_on, rationale: "Reviewable"}; }
export function brief(c = cohort()): BriefBody { return {cohort_id: c.id, repository_key: c.repository_key, depends_on: c.depends_on, files_in_scope: [], build_items: c.allocations.map((a, i) => ({id: `B${i+1}`, requirement_ids: [a.requirement_id], instructions: a.contribution, verification: ["Verify behavior"]})), technical_decisions: [{id: "D1", build_item_ids: ["B1"], decision: "Existing pattern", rationale: "Precedent"}]}; }
export function assessment(kind: "build_item" | "requirement" = "build_item"): AssessmentBody { return {head_sha: "sha", item_assessments: (kind === "build_item" ? ["B1", "B2"] : ["R1", "R2"]).map(id => ({subject: {kind, id}, status: "met", observation: "Verified", evidence: []})), additional_findings: [], next_actions: [], test_evidence: {passed: 1, failed: 0}, verdict: "pass"}; }
export const buildResult = {head_sha: "sha", summary: "Built", changed_files: [], tests: {passed: 1, failed: 0}, known_issues: []};
export const pr = {pr_url: "https://example.com/pr/1", branch: "feature", summary: "Change", review_status: "draft"};
export function validationFeedback(run: TestRun): string { return JSON.stringify(run.result.snapshot.decisions); }
