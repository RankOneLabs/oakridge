import { canonicalDigest } from "canonical-json";
import type { JsonValue, Result } from "../src/domain/primitives";
import { uniformDrilldownPages, type DrilldownRow, type LogicalItemComposite, type LogicalItemLineage, type Paged, type StageComposite } from "../src/grading/composite";
import { stampCapture, type GradingRegistration } from "../src/grading/configuration";
import type { ConfigurationIdentity } from "../src/grading/evidence";
import { INITIAL_SOURCE_CURSOR } from "../src/ingest/cursor";
import { ARTIFACT_KEYS, type ArtifactKey } from "../src/producers/oakridge/artifact-versions";
import { deliverSourceEvent } from "../src/storage/capture-store";
import type { CommittedEventDelivery } from "../src/ingest/dbos-revision-delivery";
import type { RollupContext } from "../src/grading/task-stages";
import { oakridgeProfile as createOakridgeProfile } from "../src/producers/oakridge/profile";
import type { Database, TenantScope } from "../src/storage/database";
import { listRunComposites, listRunUnresolvedReferences, readCompositeDrilldown, readLogicalItemComposite, readLogicalItemLineage } from "../src/storage/grading-record-store";
import { registerDefinitions } from "../src/storage/grading-store";
import { readSpend, type GradingRunLabel, type GradingRunOptions } from "./grading";
import { NO_EVIDENCE, scenarioStatus, type MeasurementReadback, type ProofCheck, type ProofFailure, type RelationCheckpoint, type RunReference, type ScenarioReport, type SpendReadback } from "./proof-contract";
import type { ProofIo } from "./shadow-session";
import type { SourceRunInput } from "./source-run";

const oakridgeProfile = createOakridgeProfile([]);
const path = oakridgeProfile.composite;
const WHOLE = { limit: 200, offset: 0 };
/** Named by no task list, so its edge stays unresolved and visible. */
export const UNRESOLVED_TASK = "T-not-in-this-run";
const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });

export interface ObservationReads { readonly db: Database; readonly tenant: TenantScope; context?(run_id: string): Promise<RollupContext>; close(): Promise<void> }
export interface RelationsSource {
  run(label: GradingRunLabel, options: GradingRunOptions): Promise<{ readonly report: ScenarioReport; readonly run: RunReference | null }>;
  /** Plans two cohorts sharing one task, for the wider real run. */
  readonly shared_input: SourceRunInput;
  /** The shadow's own observation database under its provisioned role, and the shadow's tenant. */
  openObservation(): Promise<Result<ObservationReads, ProofFailure>>;
}

const digestOf = (value: unknown): string => {
  const digest = canonicalDigest(value as JsonValue);
  return digest.ok ? digest.value : JSON.stringify(value);
};
const stageOf = (read: LogicalItemComposite | null, stage: string): StageComposite | undefined => read?.stages.find((candidate) => candidate.stage === stage);

// ------------------------------------------------------------ before and after ---

async function served(io: ProofIo, route: string): Promise<unknown> {
  const read = await io.observationGet(route, "read");
  if (!read.ok) throw new Error(`${route}: ${read.error.detail}`);
  return read.value;
}
/** An item's state apart from its links, which an explicit link is meant to change. */
export function withoutLinks(status: unknown): unknown {
  if (status === null || typeof status !== "object") return status;
  const { links: _links, ...measured } = status as { readonly links?: unknown };
  return measured;
}
/** What must not move for one item, each as its own read route serves it. */
async function itemFacts(io: ProofIo, occurrence_id: string): Promise<RelationCheckpoint["linked"]> {
  const id = encodeURIComponent(occurrence_id);
  return { occurrence_id, occurrence: await served(io, `/v1/items/${id}`), evidence: await served(io, `/v1/items/${id}/evidence`),
    grades: await served(io, `/v1/items/${id}/grades?limit=200`), measurements: withoutLinks(await served(io, `/v1/items/${id}/status?limit=200&machine_limit=200&attempts_limit=200&answers_limit=200&superseded_answers_limit=200&references_limit=200&pinned_evaluators_limit=200`)) };
}
export async function authorityEvents(io: ProofIo, run_id: string): Promise<number | null> {
  if (!/^[\w.:/-]+$/.test(run_id)) return null;
  const counted = await io.shadowQuery(io.state.postgres.authority_database, `SELECT count(*) FROM authority.event WHERE run_id = '${run_id}'`);
  return counted.ok ? Number(counted.value) : null;
}
export async function relationCheckpoint(io: ProofIo, input: { readonly checkpoint: string; readonly run_id: string; readonly linked: string; readonly control: string }): Promise<RelationCheckpoint> {
  const spend: SpendReadback = await readSpend(io, input.run_id, input.checkpoint);
  return { checkpoint: input.checkpoint, run_id: input.run_id, linked: await itemFacts(io, input.linked), control: await itemFacts(io, input.control),
    requests_sent: spend.requests_sent, attempts: spend.attempts, executions: spend.executions, authority_events: await authorityEvents(io, input.run_id) };
}

/** Nothing about either item, and no count of what was sent, moved between two checkpoints. */
export function unchangedChecks(before: RelationCheckpoint, after: RelationCheckpoint, reason: string): readonly ProofCheck[] {
  const same = (facts: "linked" | "control", field: "occurrence" | "evidence" | "grades" | "measurements") => digestOf(before[facts][field]) === digestOf(after[facts][field]);
  const fields = ["occurrence", "evidence", "grades", "measurements"] as const;
  const moved = (facts: "linked" | "control") => fields.filter((field) => !same(facts, field));
  return [
    check(`${reason}: the linked item's identity, pins, frozen evidence, measurements and answers are unchanged`, moved("linked").length === 0,
      moved("linked").length === 0 ? `${before.checkpoint} -> ${after.checkpoint}` : `changed: ${moved("linked").join(", ")}`),
    check(`${reason}: the unlinked control is unchanged`, moved("control").length === 0, moved("control").length === 0 ? `${before.checkpoint} -> ${after.checkpoint}` : `changed: ${moved("control").join(", ")}`),
    check(`${reason}: no execution, provider attempt or request was added`, before.requests_sent === after.requests_sent && before.attempts === after.attempts
      && digestOf(before.executions) === digestOf(after.executions),
      `${before.requests_sent} then ${after.requests_sent} request(s), ${before.attempts} then ${after.attempts} attempt(s)`),
  ];
}

/** The task reads the finding's own answers: the very observations it had before the link. */
export function compositeOriginalAnswerChecks(read: LogicalItemComposite | null, answered: readonly MeasurementReadback[], row_observations: readonly string[]): readonly ProofCheck[] {
  const stage = stageOf(read, "analysis");
  const originals = answered.flatMap((measurement) => measurement.observation_id ? [measurement.observation_id] : []);
  return [
    check("the task's composite shows the original answer as soon as the link arrives", stage?.state === "linked" && stage.results.some((result) => result.status.state === "answered"),
      JSON.stringify(stage?.results.map((result) => result.status.state) ?? null)),
    check("what its count opens is the original observation, not a new one", originals.length > 0 && originals.every((id) => row_observations.includes(id)), `${row_observations.join(", ")} against ${originals.join(", ")}`),
  ];
}

// --------------------------------------------------------------- a real run's reads ---

async function composites(reads: ObservationReads, run_id: string): Promise<Paged<LogicalItemComposite>> {
  return listRunComposites(reads.db, reads.tenant, path, run_id, WHOLE, await reads.context?.(run_id));
}
export async function drilldownChecks(reads: ObservationReads, run_id: string, read: LogicalItemComposite): Promise<readonly ProofCheck[]> {
  const counted = read.stages.flatMap((stage) => [...stage.answers.map((count) => ({ drilldown: count.drilldown, count: count.count })),
    ...stage.statuses.map((count) => ({ drilldown: count.drilldown, count: count.count })),
    { drilldown: stage.items, count: stage.totals.contributing_items }]);
  const mismatched: string[] = [];
  const unwalked: string[] = [];
  for (const { drilldown, count } of counted) {
    const whole = await readCompositeDrilldown(reads.db, reads.tenant, path, run_id, drilldown, uniformDrilldownPages(WHOLE));
    if (whole.total !== count) mismatched.push(`${JSON.stringify(drilldown.selector)}: count ${count}, rows ${whole.total}`);
    const walked: string[] = [];
    for (let offset = 0; offset <= count; offset++) walked.push(...(await readCompositeDrilldown(reads.db, reads.tenant, path, run_id, drilldown,
      { ...uniformDrilldownPages(WHOLE), rows: { limit: 1, offset } })).items.map((row) => row.item.occurrence_id));
    if (digestOf([...walked].sort()) !== digestOf(whole.items.map((row) => row.item.occurrence_id as string).sort())) unwalked.push(JSON.stringify(drilldown.selector));
  }
  return [check("every count opens exactly as many raw rows as it reports", counted.length > 0 && mismatched.length === 0, mismatched.join("; ") || `${counted.length} count(s)`),
    check("one-row pages reach the same rows", unwalked.length === 0, unwalked.join("; ") || "every boundary continued")];
}

/** The lineage a real run's task reads: its list, plan and brief entries, and the stages it reached. */
export function lineageChecks(lineage: LogicalItemLineage): readonly ProofCheck[] {
  const kinds = new Set(lineage.items.flatMap((entry) => entry.kind === "occurrence" ? [entry.artifact_kind] : []));
  const stages = new Set(lineage.items.flatMap((entry) => entry.kind === "contribution" ? [entry.item.stage] : []));
  return [check("the task's lineage runs through its specification and plan entries at exact revisions and paths", ["spec", "plan"].every((kind) => kinds.has(kind)),
    [...kinds].join(", ")),
  check("the task's lineage reaches the analysis finding and the implementation assessment", stages.has("analysis") && stages.has("cohort"), [...stages].join(", "))];
}

/** Every run's latest count, added up: a later run's early checkpoint says nothing of an earlier run's requests. */
export function totalRequests(checkpoints: readonly RelationCheckpoint[]): number | null {
  if (checkpoints.length === 0) return null;
  return [...new Map(checkpoints.map((checkpoint) => [checkpoint.run_id, checkpoint.requests_sent])).values()].reduce((total, sent) => total + sent, 0);
}

// ---------------------------------------------------------- a real two-cohort run ---

/** Every question window and answer window of a drilldown continues to the same whole lists. */
export async function nestedPageChecks(reads: ObservationReads, run_id: string, read: LogicalItemComposite): Promise<readonly ProofCheck[]> {
  const unwalked: string[] = [];
  let questions_walked = 0;
  let answers_walked = 0;
  for (const stage of read.stages) {
    const whole = await readCompositeDrilldown(reads.db, reads.tenant, path, run_id, stage.items, uniformDrilldownPages(WHOLE));
    for (let row = 0; row < whole.items.length; row++) {
      const expected = whole.items[row]!.questions;
      const rows = { limit: 1, offset: row };
      const walkedQuestions: string[] = [];
      for (let offset = 0; offset < expected.total; offset++) {
        const windowed = await readCompositeDrilldown(reads.db, reads.tenant, path, run_id, stage.items, { ...uniformDrilldownPages(WHOLE), rows, questions: { limit: 1, offset } });
        walkedQuestions.push(...windowed.items[0]!.questions.items.map((question) => question.question.question_id));
        questions_walked += 1;
        const answers = expected.items[offset]!.answers;
        const walkedAnswers: string[] = [];
        for (let at = 0; at < answers.total; at++) {
          const page = await readCompositeDrilldown(reads.db, reads.tenant, path, run_id, stage.items, { ...uniformDrilldownPages(WHOLE), rows, questions: { limit: 1, offset }, answers: { limit: 1, offset: at } });
          walkedAnswers.push(...page.items[0]!.questions.items[0]!.answers.items.map((answer) => answer.observation_id as string));
          answers_walked += 1;
        }
        if (digestOf(walkedAnswers) !== digestOf(answers.items.map((answer) => answer.observation_id as string))) unwalked.push(`${stage.stage} row ${row} question ${offset} answers`);
      }
      if (digestOf(walkedQuestions) !== digestOf(expected.items.map((question) => question.question.question_id))) unwalked.push(`${stage.stage} row ${row} questions`);
    }
  }
  return [check("one-entry windows reach every nested question and raw answer", questions_walked > 0 && answers_walked > 0 && unwalked.length === 0,
    unwalked.join("; ") || `${questions_walked} question window(s), ${answers_walked} answer window(s)`)];
}

export interface SharedRunReads {
  readonly shared: LogicalItemComposite | null;
  /** A task sharing one finding with the shared task. */
  readonly other: LogicalItemComposite | null;
  readonly implementation_rows: Paged<DrilldownRow> | null;
  readonly lineage: LogicalItemLineage;
  readonly unlinked_control: boolean;
  readonly unresolved_visible: boolean;
}
/** What a real run sharing one task between two cohorts must read. */
export function sharedRunChecks(reads: SharedRunReads): readonly ProofCheck[] {
  const implementation = stageOf(reads.shared, "cohort");
  const units = implementation?.publication.state === "published" ? implementation.publication.unit_ids : [];
  const contributing = [...new Set(reads.implementation_rows?.items.map((row) => row.item.unit_id) ?? [])].sort();
  const occurrences = reads.lineage.items.flatMap((entry) => entry.kind === "occurrence" ? [entry] : []);
  const of = (artifact: string) => occurrences.filter((entry) => entry.artifact_kind === artifact);
  const answered = reads.implementation_rows?.items.filter((row) => row.questions.items.some((question) => question.answers.total > 0)) ?? [];
  const superseded = (artifact: string) => of(artifact).some((entry) => !entry.is_current);
  const briefUnits = [...new Set(of("brief").map((entry) => entry.unit_id))];
  return [
    check("real: one task stands under both cohorts' implementation assessments", units.length === 2 && digestOf(contributing) === digestOf([...units].sort()), `${contributing.join(", ")} of ${units.join(", ")}`),
    check("real: the provider answered findings of that task in both cohorts", new Set(answered.map((row) => row.item.unit_id)).size === 2, `${answered.length} answered item(s)`),
    check("real: the analysis stage holds both findings linked by the approval, apart from implementation", stageOf(reads.shared, "analysis")?.totals.contributing_items === 2, JSON.stringify(stageOf(reads.shared, "analysis")?.totals ?? null)),
    check("real: a finding linked to two tasks reads under both", stageOf(reads.other, "analysis")?.totals.contributing_items === 1, reads.other?.producer_local_id ?? "no task"),
    check("real: the task is one logical item through its task list, the revised plan and both revised briefs", of("spec").length >= 1 && superseded("plan") && superseded("brief") && briefUnits.length === 2,
      `${of("plan").length} plan and ${of("brief").length} brief occurrence(s) across ${briefUnits.length} brief unit(s)`),
    check("real: integration reads as pending, since no cohort of this run completed", stageOf(reads.shared, "integration")?.publication.state === "pending", JSON.stringify(stageOf(reads.shared, "integration")?.publication ?? null)),
    check("real: the unlinked control stays listed", reads.unlinked_control, "unlinked items"),
    check("real: the unknown task stays a visible reference", reads.unresolved_visible, UNRESOLVED_TASK),
  ];
}

/** Exercise a shared requirement on the same capture path used by authority delivery. */
export async function sharedTaskMatrix(db: Database, tenant: TenantScope, registration: GradingRegistration, identity: ConfigurationIdentity): Promise<{ readonly checks: readonly ProofCheck[]; readonly reads: unknown }> {
  const run_id = "matrix-run";
  const registered = await registerDefinitions(db, tenant, registration);
  if (!registered.ok) return { checks: [check("the matrix tenant registers its definitions", false, registered.error.detail)], reads: null };
  const configuration = stampCapture(registration.capture, identity);
  const development = ARTIFACT_KEYS.development;
  let previous = INITIAL_SOURCE_CURSOR;
  const capture = async (key: ArtifactKey, revision_id: string, unit_id: string, body: JsonValue, bound: readonly string[] = []) => {
    const digest = canonicalDigest(body);
    if (!digest.ok) throw new Error(digest.error.detail);
    const event_id = `event:${revision_id}`;
    const cursor = { commit_txid: String(BigInt(previous.commit_txid) + 1n), event_id };
    const delivery: CommittedEventDelivery = { producer: "oakridge", namespace: tenant.namespace, previous, cursor, run_id, event_id,
      event: { kind: "revisions", revisions: [{ revision_id, unit_id, run_id, stage: key.stage, artifact: key.artifact,
        definition_id: key.definition_id!, schema_version: key.schema_version, body, body_digest: digest.value, predecessor_id: null,
        subject_id: null, origin: { kind: "operator_edit" }, input_bindings: bound.map((id) => ({ input: "source", unit: id, revision_id: id })),
        recorded_at: new Date().toISOString() }] } };
    const result = await deliverSourceEvent(db, tenant, delivery, { extraction: oakridgeProfile.extraction, configuration });
    if (result.status !== 200) throw new Error(`matrix delivery refused: ${JSON.stringify(result.body)}`);
    previous = cursor;
  };
  await capture(development.analysis.spec, "spec:1", "analysis", { requirements: [{ id: "R1", text: "Shared requirement",
    acceptance_conditions: ["Covered"], analysis_finding_ids: [], source_refs: [] }] });
  for (const repository_key of ["alpha", "beta"]) {
    const brief = `${repository_key}:brief:1`;
    await capture(development.brief.brief, brief, `${repository_key}:brief`, { cohort_id: repository_key, assigned_repository: repository_key,
      build_items: [{ id: "B1", requirement_ids: ["R1"], instructions: "Build", verification: ["Test it"] }], technical_decisions: [] });
    if (repository_key === "alpha") await capture(development.cohort.assessment, "alpha:assessment:1", "alpha:cohort", {
      item_assessments: [{ subject: { kind: "build_item", id: "B1" }, status: "met", finding_note: "Verified", supporting_citations: [] }],
      additional_findings: [], proposals: [], verifications: [],
    }, [brief]);
  }
  const read = await readLogicalItemComposite(db, tenant, path, run_id, "R1");
  const lineage = await readLogicalItemLineage(db, tenant, path, run_id, "R1", WHOLE);
  const contributions = lineage.items.flatMap((entry) => entry.kind === "contribution" ? [entry] : []);
  const judgment = read?.repositories[0]?.judgments[0];
  const unresolved = await listRunUnresolvedReferences(db, tenant, path, run_id, WHOLE);
  return { reads: read, checks: [
    check("matrix: the specification defines one captured requirement", read?.task_kind === "requirement" && lineage.is_captured
      && lineage.items.filter((entry) => entry.kind === "occurrence" && entry.revision_id === "spec:1").length === 1, JSON.stringify(read?.logical_item_id)),
    check("matrix: applicability includes both repositories", read?.repositories.map((row) => row.repository_key).join(",") === "alpha,beta", JSON.stringify(read?.repositories)),
    check("matrix: a judgment stays with the bound build item", judgment?.status === "met" && judgment.assessment_revision_id === "alpha:assessment:1",
      JSON.stringify(judgment)),
    check("matrix: the repository awaiting assessment has no judgments", read?.repositories[1]?.judgments.length === 0, JSON.stringify(read?.repositories[1])),
    check("matrix: both build items and their assessment contribute to the requirement", contributions.length === 3
      && contributions.some((entry) => entry.item.revision_id === "alpha:assessment:1"), JSON.stringify(contributions.map((entry) => entry.item.revision_id))),
    check("matrix: every authored reference resolves", unresolved.total === 0, JSON.stringify(unresolved.items)),
  ] };
}

export async function relationsScenario(_io: ProofIo, source: RelationsSource, _matrix_namespace: string): Promise<ScenarioReport> {
  const { report, run } = await source.run("shared", { grading_enabled: true, through: "assessment", capture: "await",
    input: source.shared_input, target_units: 2 });
  const checks: ProofCheck[] = [...report.checks];
  if (!run || report.status !== "passed") return { id: "relations", status: "failed", evidence: report.evidence, checks };
  const open = await source.openObservation();
  if (!open.ok) return { id: "relations", status: "failed", evidence: report.evidence,
    checks: [...checks, check("observation reads are available", false, open.error.detail)] };
  try {
    const compositesForRun = await composites(open.value, run.run_id);
    const shared = compositesForRun.items.find((item) => item.repositories.length >= 2);
    checks.push(check("the run has a requirement shared by two repositories", !!shared, shared?.logical_item_id ?? run.run_id));
    if (shared) {
      const lineage = await readLogicalItemLineage(open.value.db, open.value.tenant, path, run.run_id, shared.logical_item_id, WHOLE);
      checks.push(check("the shared requirement has an assessment contribution", lineage.items.some((entry) =>
        entry.kind === "contribution" && entry.item.item_kind === "item_assessment"), String(lineage.total)));
    }
  } finally { await open.value.close(); }
  return { id: "relations", status: scenarioStatus(checks), evidence: report.evidence ?? NO_EVIDENCE, checks };
}
