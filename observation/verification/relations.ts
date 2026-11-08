/**
 * Explicit late links and task composites on the real shadow, continuing `grading`:
 *
 *   an enabled run's analysis is answered by the configured provider before the run has any task ->
 *   its tasks are approved, which creates no grading record -> a caller supplies one explicit mapping
 *   naming that exact approved tasks revision and an original finding -> it is journaled and delivered,
 *   and the finding's original answer reads under the task at once with its identity, pins, evidence,
 *   executions, attempts and request counts unchanged, beside an unlinked graded control -> the run goes
 *   on to its assessment -> a second mapping is journaled with observation down, and the whole stack
 *   restarts before any acknowledgement: it arrives once and nothing is regraded.
 *
 * A second real run shares one task between two cohorts: its tasks approval itself carries explicit
 * links, its plan and both briefs are sent back and really revised, and both cohorts reach their
 * assessments. It stops there, with integration read as pending. Completing a cohort takes an operator's
 * acceptance of its assessment and confirmation of a merge, which this proof does not make on its own.
 *
 * The shared-task matrix (integration pending then final, corrections and disagreement) therefore stays
 * as a supplement, in a tenant of its own on the shadow's database: real ordered delivery and real
 * schema, but synthetic revisions and answers, which the report labels as such. No service ever works
 * that tenant, so it sends no request.
 */
import { resolve } from "node:path";
import { canonicalDigest } from "canonical-json";
import type { EvaluatorDefinitionId, EvidenceSetId, ItemOccurrenceId } from "../src/domain/identity";
import type { JsonValue, Result } from "../src/domain/primitives";
import { uniformDrilldownPages, type DrilldownRow, type LogicalItemComposite, type LogicalItemLineage, type Paged, type StageComposite } from "../src/grading/composite";
import type { GradingRegistration } from "../src/grading/configuration";
import { AUTOMATIC_ATTEMPT_LABEL, evaluationDigest, submissionAttemptLabel, submissionDigest } from "../src/grading/execution";
import type { GradeAnswer } from "../src/grading/observation";
import type { SourceEventCursor, SourceEventOutcome } from "../src/ingest/cursor";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { readOccurrenceEvidence, recordCollection } from "../src/storage/captured-evidence-store";
import { deliverSourceEvent, readRelationDeclarations } from "../src/storage/capture-store";
import { jsonText, withTenant, type Database, type TenantScope } from "../src/storage/database";
import { listRunComposites, listRunUnlinkedItems, listRunUnresolvedReferences, readCompositeDrilldown, readLogicalItemComposite, readLogicalItemLineage } from "../src/storage/grading-record-store";
import { registerDefinitions } from "../src/storage/grading-store";
import { listRunItems } from "../src/storage/projection-store";
import { readSpend, readUntil, runItems, settledRun, unlinkedAnalysisChecks, type GradingRunLabel, type GradingRunOptions } from "./grading";
import { NO_EVIDENCE, scenarioStatus, type MeasurementReadback, type ProofCheck, type ProofFailure, type RelationCheckpoint, type RelationsReadback, type RunReference, type ScenarioReport,
  type SpendReadback } from "./proof-contract";
import { graderPlans } from "./registration";
import { observationSettled, settleObservation } from "./scenarios";
import type { ProofIo } from "./shadow-session";
import type { ReviewCheckpoint, SourceRunInput } from "./source-run";

const path = oakridgeProfile.composite;
const POLL_MS = 1_000;
const DELIVERY_ATTEMPTS = 180;
const SHARED_RUN_TIMEOUT_MS = 5_400_000;
const WHOLE = { limit: 200, offset: 0 };
/** Named by no task list, so its edge stays unresolved and visible. */
export const UNRESOLVED_TASK = "T-not-in-this-run";
const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });

export interface ObservationReads { readonly db: Database; readonly tenant: TenantScope; close(): Promise<void> }
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
/** What must not move for one item, each as its own read route serves it. */
async function itemFacts(io: ProofIo, occurrence_id: string): Promise<RelationCheckpoint["linked"]> {
  const id = encodeURIComponent(occurrence_id);
  return { occurrence_id, occurrence: await served(io, `/v1/items/${id}`), evidence: await served(io, `/v1/items/${id}/evidence`),
    grades: await served(io, `/v1/items/${id}/grades?limit=200`), measurements: await served(io, `/v1/items/${id}/measurements`) };
}
async function authorityEvents(io: ProofIo, run_id: string): Promise<number | null> {
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
    check("the task's composite shows the original answer as soon as the link arrives", stage?.coverage === "linked" && (stage.answers.length > 0),
      JSON.stringify(stage?.answers.map((count) => [count.question.question_id, count.answer, count.count]) ?? null)),
    check("what its count opens is the original observation, not a new one", originals.length > 0 && originals.every((id) => row_observations.includes(id))
      && row_observations.every((id) => originals.includes(id)), `${row_observations.join(", ")} against ${originals.join(", ")}`),
  ];
}

// --------------------------------------------------------------- a real run's reads ---

async function composites(reads: ObservationReads, run_id: string): Promise<Paged<LogicalItemComposite>> {
  return listRunComposites(reads.db, reads.tenant, path, run_id, WHOLE);
}
const untilLinked = async (io: ProofIo, reads: ObservationReads, run_id: string, task_id: string, stage: string): Promise<LogicalItemComposite | null> => {
  let read: LogicalItemComposite | null = null;
  for (let attempt = 0; attempt < DELIVERY_ATTEMPTS; attempt++) {
    read = await readLogicalItemComposite(reads.db, reads.tenant, path, run_id, task_id);
    if (stageOf(read, stage)?.coverage === "linked") return read;
    await io.sleep(POLL_MS);
  }
  return read;
};
const declareRoute = (run_id: string): string => `/api/runs/${run_id}/analysis-links`;
const answerObservations = async (reads: ObservationReads, run_id: string, read: LogicalItemComposite | null, stage: string): Promise<readonly string[]> => {
  const counted = stageOf(read, stage);
  if (!counted) return [];
  const rows = await Promise.all(counted.answers.map((count) => readCompositeDrilldown(reads.db, reads.tenant, path, run_id, count.drilldown, uniformDrilldownPages(WHOLE))));
  return [...new Set(rows.flatMap((page) => page.items.flatMap((row) => row.questions.items.flatMap((question) => question.answers.items.map((answer) => answer.observation_id as string)))))];
};

/** Every count opens exactly as many rows as it says, and a one-row page walks the same population. */
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
  return [check("the task's lineage runs through its task list, plan and brief entries at exact revisions and paths", ["tasks", "plan", "brief"].every((kind) => kinds.has(kind)),
    [...kinds].join(", ")),
  check("the task's lineage reaches the analysis finding and the implementation assessment", stages.has("analysis") && stages.has("implementation"), [...stages].join(", "))];
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
  const implementation = stageOf(reads.shared, "implementation");
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
    check("real: the task is one logical item through its task list, the revised plan and both revised briefs", of("tasks").length >= 1 && superseded("plan") && superseded("brief") && briefUnits.length === 2,
      `${of("plan").length} plan and ${of("brief").length} brief occurrence(s) across ${briefUnits.length} brief unit(s)`),
    check("real: integration reads as pending, since no cohort of this run completed", stageOf(reads.shared, "integration")?.publication.state === "pending", JSON.stringify(stageOf(reads.shared, "integration")?.publication ?? null)),
    check("real: the unlinked control stays listed", reads.unlinked_control, "unlinked items"),
    check("real: the unknown task stays a visible reference", reads.unresolved_visible, UNRESOLVED_TASK),
  ];
}

const SHARED_TASK = "T1";
const OTHER_TASK = "T2";
const REVISION_FEEDBACK = "Add one short sentence to the summary saying this revision was requested by the live verification run. Change nothing else: keep every cohort, task id and decision.";

interface SharedRunCollectors { readonly checks: ProofCheck[]; readonly runs: RunReference[]; readonly measurements: MeasurementReadback[]; readonly checkpoints: RelationCheckpoint[]; readonly readbacks: { [key: string]: unknown } }
const keptIn = (checks: ProofCheck[]) => (step: (run: RunReference, target: string) => Promise<ProofCheck>) => async (run: RunReference, target: string): Promise<ProofCheck> => {
  const outcome = await step(run, target);
  checks.push(outcome);
  return outcome;
};

/** The wider real run. The approval's own explicit links, real revisions and both assessments, then every read. */
async function sharedRun(io: ProofIo, source: RelationsSource, open: ObservationReads, collectors: SharedRunCollectors): Promise<void> {
  const { checks, runs, measurements, checkpoints, readbacks } = collectors;
  const kept = keptIn(checks);
  let first: FindingAddress | null = null;
  let second: FindingAddress | null = null;
  let control: FindingAddress | null = null;
  let originals: readonly MeasurementReadback[] = [];
  let beforeApproval: RelationCheckpoint | null = null;
  const analysisAnswered: ReviewCheckpoint = { review: "analysis_review", before: kept(async (run) => {
    const read = await readUntil(io, run.run_id, "shared-before-tasks", settledRun);
    measurements.push(...read);
    const findings = [...new Map(read.filter((measurement) => measurement.item_kind === "finding" && measurement.state === "answered")
      .map((measurement) => [measurement.occurrence_id, measurement])).values()].sort((left, right) => left.item_path.localeCompare(right.item_path, undefined, { numeric: true }));
    const [one, two] = findings;
    const last = findings.at(-1);
    if (!one || !two || !last || last === two) return check("the shared run's analysis has three answered findings", false, `${findings.length} answered finding(s)`);
    first = one; second = two; control = last;
    originals = read.filter((measurement) => measurement.occurrence_id === one.occurrence_id);
    return check("the shared run's analysis has three answered findings", true, `${one.item_path}, ${two.item_path}, control ${last.item_path}`);
  }) };
  const tasksApproved: ReviewCheckpoint = { review: "tasks_review",
    analysis_links: () => first && second ? [
      { source_revision_id: first.revision_id, item_path: first.item_path, task_ids: [SHARED_TASK, OTHER_TASK] },
      { source_revision_id: second.revision_id, item_path: second.item_path, task_ids: [SHARED_TASK, UNRESOLVED_TASK] }] : [],
    before: kept(async (run) => {
      if (!first || !control) return check("the shared run chose its findings", false, "no analysis checkpoint");
      beforeApproval = await relationCheckpoint(io, { checkpoint: "shared-before-approval", run_id: run.run_id, linked: first.occurrence_id, control: control.occurrence_id });
      checkpoints.push(beforeApproval);
      return check("the shared run chose its findings", true, `${first.item_path} and ${second?.item_path}`);
    }),
    after: kept(async (run, target) => {
      if (!first || !control || !beforeApproval) return check("the approval's links were supplied", false, "no earlier checkpoint");
      let stored = await readRelationDeclarations(open.db, open.tenant, run.run_id);
      for (let attempt = 0; attempt < DELIVERY_ATTEMPTS && stored.length === 0; attempt++) { await io.sleep(POLL_MS); stored = await readRelationDeclarations(open.db, open.tenant, run.run_id); }
      readbacks.shared_declarations = stored;
      const read = await untilLinked(io, open, run.run_id, SHARED_TASK, "analysis");
      readbacks.shared_after_approval = read;
      const after = await relationCheckpoint(io, { checkpoint: "shared-after-approval", run_id: run.run_id, linked: first.occurrence_id, control: control.occurrence_id });
      checkpoints.push(after);
      checks.push(...unchangedChecks(beforeApproval, after, "the approval's links"));
      checks.push(...compositeOriginalAnswerChecks(read, originals, (await answerObservations(open, run.run_id, read, "analysis")).filter((id) => originals.some((original) => original.observation_id === id))));
      return check("the tasks approval's own explicit links were delivered once", stored.length === 1 && JSON.stringify(stored[0]).includes(target), `${stored.length} declaration(s) for ${target}`);
    }) };
  const { report, run } = await source.run("shared", { grading_enabled: true, through: "assessment", capture: "await", input: source.shared_input, target_units: 2, timeout_ms: SHARED_RUN_TIMEOUT_MS,
    reviews: [analysisAnswered, tasksApproved, { review: "plan_review", revision_feedback: REVISION_FEEDBACK }, { review: "brief_review", revision_feedback: REVISION_FEEDBACK }] });
  checks.push(check("the shared run reaches both cohorts' assessments on the real stack", report.status === "passed" && run !== null,
    report.checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`).join("; ") || run?.run_id || "no run"));
  if (run) runs.push(run);
  if (!run || !first || !control) return;
  const { occurrence_id: control_id } = control as FindingAddress;
  measurements.push(...await readUntil(io, run.run_id, "shared-settled", settledRun));
  checkpoints.push(await relationCheckpoint(io, { checkpoint: "shared-settled", run_id: run.run_id, linked: (first as FindingAddress).occurrence_id, control: control_id }));
  readbacks.shared_addresses = { first, second, control };
  const shared = await readLogicalItemComposite(open.db, open.tenant, path, run.run_id, SHARED_TASK);
  const other = await readLogicalItemComposite(open.db, open.tenant, path, run.run_id, OTHER_TASK);
  const implementation = stageOf(shared, "implementation");
  const implementation_rows = implementation ? await readCompositeDrilldown(open.db, open.tenant, path, run.run_id, implementation.items, uniformDrilldownPages(WHOLE)) : null;
  const lineage = await readLogicalItemLineage(open.db, open.tenant, path, run.run_id, SHARED_TASK, WHOLE);
  const unlinked = await listRunUnlinkedItems(open.db, open.tenant, path, run.run_id, WHOLE);
  const unresolved = await listRunUnresolvedReferences(open.db, open.tenant, path, run.run_id, WHOLE);
  readbacks.shared_run = { shared, other, implementation_rows, lineage, unlinked, unresolved };
  checks.push(...sharedRunChecks({ shared, other, implementation_rows, lineage, unlinked_control: unlinked.items.some((item) => item.occurrence_id === control_id),
    unresolved_visible: unresolved.items.some((reference) => reference.unresolved_target_ref === `logical_item:task:${UNRESOLVED_TASK}`) }));
  if (shared) checks.push(...await drilldownChecks(open, run.run_id, shared), ...await nestedPageChecks(open, run.run_id, shared));
}

// --------------------------------------------------------- the shared-task matrix ---

const fixture = async (name: string): Promise<JsonValue> => await Bun.file(resolve(import.meta.dir, `../fixtures/oakridge/${name}-revision.json`)).json() as JsonValue;
const finding = (task_ids: readonly string[]): JsonValue => ({ task_ids: [...task_ids], criterion: "c", status: "met", evidence: [] });
const choice = (value: string): GradeAnswer => ({ state: "answered", kind: "choice", value });
const CORRECTNESS = "assessment_finding.correctness";
const RELEVANCE = "finding.relevance";

/** One run of synthetic revisions through the real delivery path, with answers stored under the execution
 * contract. It is labelled synthetic in the report: it proves the reads on this database, not a real run. */
export async function sharedTaskMatrix(db: Database, tenant: TenantScope, registration: GradingRegistration): Promise<{ readonly checks: readonly ProofCheck[]; readonly reads: unknown }> {
  const run_id = "matrix-run";
  const registered = await registerDefinitions(db, tenant, registration);
  if (!registered.ok) return { checks: [check("the matrix tenant registers its definitions", false, registered.error.detail)], reads: null };
  const human = registration.evaluators.find((evaluator) => evaluator.kind === "human");
  if (!human) return { checks: [check("the selection has a human evaluator", false, "missing")], reads: null };
  let cursor: SourceEventCursor = { commit_txid: "0", id: "" };
  let sequence = 0;
  const provenance = { format: "observation.source-event/v1", definition_id: "matrix", artifact_schema_version: null } as const;
  const send = async (outcome: SourceEventOutcome): Promise<void> => {
    const next = { commit_txid: String(++sequence), id: outcome.event_id };
    const result = await deliverSourceEvent(db, tenant, { previous: cursor, cursor: next, outcome }, { extraction: oakridgeProfile.extraction, configuration: registration.capture });
    if (result.status !== 200) throw new Error(`matrix delivery refused: ${JSON.stringify(result.body)}`);
    cursor = next;
  };
  const revision = async (revision_id: string, artifact_kind: string, unit_id: string, body: JsonValue, predecessor_id: string | null = null): Promise<void> => {
    const digest = canonicalDigest(body);
    if (!digest.ok) throw new Error(digest.error.detail);
    const prefix = `${tenant.producer}:${tenant.namespace}:`;
    await send({ ...provenance, artifact_schema_version: "matrix-schema", kind: "artifact_revision", event_kind: "revision_published", run_id, event_id: `event:${revision_id}`,
      revision: { format: "observation.artifact-revision/v2", source: { ...tenant, revision_id: `${prefix}${revision_id}`, run_id, unit_id, artifact_kind, artifact_schema_version: "matrix-schema",
        definition_id: "matrix", predecessor_id: predecessor_id ? `${prefix}${predecessor_id}` : null, subject_id: null }, recorded_at: new Date(Date.UTC(2026, 10, 1, 0, sequence)).toISOString(),
        body, body_digest: digest.value as `canonical-json/v1:${string}` & { readonly __brand: "CanonicalDigest" } } });
  };
  await send({ ...provenance, kind: "run_input", event_kind: "launched", run_id, event_id: "launch", input: { spec: "synthetic" }, input_schema_version: "matrix-schema",
    config: { sessions: {}, grading_enabled: true } });
  const plan = await fixture("plan") as { readonly [key: string]: JsonValue };
  const brief = await fixture("brief") as { readonly [key: string]: JsonValue };
  const shared = "T7";
  await revision("analysis-1", "analysis", `${run_id}/analysis`, { summary: "s", source_spec_refs: [], requirements: [], risks: [], proposed_spec_updates: [],
    findings: ["F1", "F2"].map((id) => ({ id, title: id, detail: id, severity: "info" })) });
  await revision("tasks-1", "tasks", `${run_id}/analysis`, await fixture("tasks"));
  await revision("plan-1", "plan", `${run_id}/planning`, plan);
  await revision("plan-2", "plan", `${run_id}/planning`, { ...plan, summary: "revised" }, "plan-1");
  await revision("brief-alpha-1", "brief", `${run_id}/briefs/alpha`, brief);
  await revision("brief-alpha-2", "brief", `${run_id}/briefs/alpha`, { ...brief, title: "revised" }, "brief-alpha-1");
  await revision("brief-beta-1", "brief", `${run_id}/briefs/beta`, { ...brief, cohort_id: "beta", acceptance_criteria: [{ id: shared, text: "beta", decision_ids: [] }] });
  await revision("assessment-alpha-1", "assessment", `${run_id}/implementation/alpha`, { findings: [finding([shared]), finding([shared, "T8"]), finding(["T404"])] });
  await revision("assessment-alpha-2", "assessment", `${run_id}/implementation/alpha`, { findings: [finding([shared]), finding([])] }, "assessment-alpha-1");
  await revision("assessment-beta-1", "assessment", `${run_id}/implementation/beta`, { findings: [finding([shared]), finding(["T404"])] });
  await send({ ...provenance, kind: "relation_declaration", event_kind: "analysis_links_declared", run_id, event_id: "declared-1",
    declaration: { run_id, tasks_revision_id: "tasks-1", entries: [{ source_revision_id: "analysis-1", item_path: "/findings/0", task_ids: [shared, "T8"] }] } });
  const occurrence = async (revision_id: string, item_path: string): Promise<ItemOccurrenceId> => {
    const item = (await listRunItems(db, tenant, run_id, WHOLE)).items.find((candidate) => candidate.revision_id === revision_id && candidate.json_pointer === item_path);
    if (!item) throw new Error(`no matrix item at ${revision_id}${item_path}`);
    return item.occurrence_id as ItemOccurrenceId;
  };
  const ready = async (occurrence_id: ItemOccurrenceId): Promise<EvidenceSetId> => {
    const sets = await readOccurrenceEvidence(db, tenant, occurrence_id);
    for (const set of sets) await recordCollection(db, tenant, set.evidence_set_id, { state: "ready",
      references: [{ source: "reported", reported_by: "agent", ref: "subject", revision_id: "synthetic", item_path: "/findings/0", content: `synthetic evidence of ${occurrence_id}` }] });
    return sets[0]!.evidence_set_id;
  };
  const answer = async (input: { readonly occurrence_id: ItemOccurrenceId; readonly question_id: string; readonly value: string; readonly reviewer?: string; readonly supersedes?: string }): Promise<string> => {
    const set = (await readOccurrenceEvidence(db, tenant, input.occurrence_id)).find((candidate) => candidate.question_id === input.question_id)!;
    const submission = { reviewer_id: input.reviewer ?? "", submission_id: crypto.randomUUID() };
    const identity = { subject_occurrence_id: input.occurrence_id, evidence_set_id: set.evidence_set_id, question_id: set.question_id, question_version: set.question_version,
      evaluator_definition_id: (input.reviewer ? human.evaluator_definition_id : set.pinned_evaluator_definition_ids.find((id) => id !== human.evaluator_definition_id)) as EvaluatorDefinitionId,
      attempt_label: input.reviewer ? submissionAttemptLabel(submission) : AUTOMATIC_ATTEMPT_LABEL };
    const digest = input.reviewer ? submissionDigest(submission) : evaluationDigest(identity);
    if (!digest.ok) throw new Error(digest.error.detail);
    const execution_id = crypto.randomUUID();
    const observation_id = crypto.randomUUID();
    const payload = choice(input.value);
    await withTenant(db, tenant, async (trx) => {
      await trx.insertInto("observation.evaluation_execution").values({ ...tenant, ...identity, execution_id, run_id, idempotency_digest: digest.value, status: "completed", lease_owner: null,
        lease_expires_at: null, terminal_cause: null, started_at: null, ended_at: new Date(), error: null, model_usage: null, cost: null, external_execution_id: null, provider_link: null, reproducibility_metadata: null }).execute();
      await trx.insertInto("observation.grade_observation").values({ ...tenant, observation_id, execution_id, answer_kind: payload.kind, answer_state: payload.state, answer_payload: jsonText(payload as JsonValue),
        probabilities: null, confidence: null, reviewer_id: input.reviewer ?? null, reviewer_details: null, comments: null, rationale: null, supersedes_observation_id: input.supersedes ?? null }).execute();
    });
    return observation_id;
  };
  const [early, alpha, beta, replaced] = await Promise.all([occurrence("analysis-1", "/findings/0"), occurrence("assessment-alpha-2", "/findings/0"), occurrence("assessment-beta-1", "/findings/0"),
    occurrence("assessment-alpha-1", "/findings/0")]);
  for (const id of [early, alpha, beta, replaced]) await ready(id);
  await answer({ occurrence_id: early, question_id: RELEVANCE, value: "relevant" });
  await answer({ occurrence_id: replaced, question_id: CORRECTNESS, value: "contradicted" });
  const wrong = await answer({ occurrence_id: alpha, question_id: CORRECTNESS, value: "contradicted", reviewer: "reviewer-a" });
  await answer({ occurrence_id: alpha, question_id: CORRECTNESS, value: "supported", reviewer: "reviewer-a", supersedes: wrong });
  await answer({ occurrence_id: alpha, question_id: CORRECTNESS, value: "contradicted", reviewer: "reviewer-b" });
  await answer({ occurrence_id: beta, question_id: CORRECTNESS, value: "contradicted" });
  const read = async (task: string) => readLogicalItemComposite(db, tenant, path, run_id, task);
  const pending = await read(shared);
  await revision("integration-1", "assessment", `${run_id}/integration/oakridge`, { findings: [finding([shared])] });
  const final = await read(shared);
  const [implementation, integration, analysis] = [stageOf(final, "implementation"), stageOf(final, "integration"), stageOf(final, "analysis")];
  const lineage = await readLogicalItemLineage(db, tenant, path, run_id, shared, WHOLE);
  const unknown = await listRunUnresolvedReferences(db, tenant, path, run_id, WHOLE);
  const unlinked = await listRunUnlinkedItems(db, tenant, path, run_id, WHOLE);
  const history = implementation ? await readCompositeDrilldown(db, tenant, path, run_id, implementation.history, uniformDrilldownPages(WHOLE)) : null;
  const disagreement = implementation?.disagreements[0] ? await readCompositeDrilldown(db, tenant, path, run_id, implementation.disagreements[0].drilldown, uniformDrilldownPages(WHOLE)) : null;
  const other = await read("T8");
  return { reads: { label: "synthetic revisions and answers on the shadow's database", pending, final, other, lineage, unknown, unlinked, history, disagreement }, checks: [
    check("matrix: integration is pending until it publishes", stageOf(pending, "integration")?.publication.state === "pending", JSON.stringify(stageOf(pending, "integration")?.publication ?? null)),
    check("matrix: published integration is final with nothing answered yet", integration?.publication.state === "published" && integration.publication.is_final && integration.answers.length === 0,
      JSON.stringify(integration?.publication ?? null)),
    check("matrix: both cohorts' current findings stand under one task", implementation?.totals.contributing_items === 2
      && implementation.publication.state === "published" && implementation.publication.unit_ids.length === 2, JSON.stringify(implementation?.publication ?? null)),
    check("matrix: a correction counts once, under its own reviewer", (implementation?.answers ?? []).filter((count) => count.grader.kind === "human" && count.grader.reviewer_id === "reviewer-a")
      .map((count) => count.answer).length === 1 && implementation?.totals.superseded_answers === 1, JSON.stringify(implementation?.totals ?? null)),
    check("matrix: differing current answers on one item and question are one disagreement", implementation?.disagreements.length === 1 && disagreement?.total === 1, JSON.stringify(disagreement?.items.map((row) => row.item.revision_id) ?? [])),
    check("matrix: a superseded revision and its answers stay in history, uncounted", history?.items.some((row) => row.item.revision_id === "assessment-alpha-1" && !row.item.is_current) === true
      && !(implementation?.answers ?? []).some((count) => count.grader.kind === "machine" && count.answer.state === "answered" && count.answer.value === "supported"), `${history?.total ?? 0} history row(s)`),
    check("matrix: a finding linked to two tasks reads under both, unchanged", stageOf(other, "analysis")?.totals.contributing_items === 1 && analysis?.totals.contributing_items === 1, "analysis-1/findings/0 under T7 and T8"),
    check("matrix: lineage holds the revised plan and briefs of both cohorts", lineage.items.filter((entry) => entry.kind === "occurrence" && entry.artifact_kind === "brief").length === 3
      && lineage.items.some((entry) => entry.kind === "occurrence" && entry.revision_id === "plan-1" && !entry.is_current), `${lineage.total} entries`),
    check("matrix: an unknown task stays a visible reference", unknown.items.some((reference) => reference.unresolved_target_ref === "logical_item:task:T404"), `${unknown.total} reference(s)`),
    check("matrix: an unlinked item stays listed", unlinked.total > 0, `${unlinked.total} unlinked item(s)`),
    check("matrix: a task nothing current links is a coverage gap in that stage", stageOf(other, "integration")?.coverage === "gap", "T8 in integration"),
  ] };
}

// ------------------------------------------------------------------------ the scenario ---

interface FindingAddress { readonly occurrence_id: string; readonly revision_id: string; readonly item_path: string }

export async function relationsScenario(io: ProofIo, source: RelationsSource, matrix_namespace: string): Promise<ScenarioReport> {
  if (await io.stackAnswers()) return { id: "relations", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("this proof owns the stack", false, "a shadow is already running; this proof restarts it")] };
  const checks: ProofCheck[] = [];
  const runs: RunReference[] = [];
  const checkpoints: RelationCheckpoint[] = [];
  const declarations: unknown[] = [];
  const readbacks: { [key: string]: unknown } = {};
  const measurements: MeasurementReadback[] = [];
  let tasks_revision_id: string | null = null;
  let linked: FindingAddress | null = null;
  let control: FindingAddress | null = null;
  let task_ids: readonly string[] = [];
  const evidence = (): ScenarioReport["evidence"] => {
    const relations: RelationsReadback = { tasks_revision_id, linked, control, checkpoints, declarations, reads: readbacks };
    return { ...NO_EVIDENCE, runs, measurements, relations, source_revisions: [...new Set(measurements.map((measurement) => measurement.revision_id))],
      item_paths: [...new Set(measurements.map((measurement) => `${measurement.revision_id}${measurement.item_path}`))],
      execution_ids: [...new Set(measurements.flatMap((measurement) => measurement.execution_id ? [measurement.execution_id] : []))],
      observation_ids: [...new Set(measurements.flatMap((measurement) => measurement.observation_id ? [measurement.observation_id] : []))],
      provider_attempt_ids: [...new Set(measurements.flatMap((measurement) => measurement.attempts.map((attempt) => `${measurement.execution_id}#${attempt.attempt}`)))],
      provider_request_count: totalRequests(checkpoints) };
  };
  const finish = (): ScenarioReport => ({ id: "relations", status: scenarioStatus(checks), checks, evidence: evidence() });
  const original = await io.readGraders();
  const plans = graderPlans(original);
  if (!plans.ok) { checks.push(check("graders.json plans a registration", false, plans.error.detail)); return finish(); }
  const started = await io.startStack();
  checks.push(check("the stack starts on the committed selection", started.ok, started.ok ? "answered" : started.error.detail));
  if (!started.ok) return finish();
  let reads: ObservationReads | null = null;
  try {
    const settled = await settleObservation(io);
    checks.push(check("observation is up", observationSettled(settled.health), `health ${settled.health}; launcher ${settled.launcher}`));
    if (!observationSettled(settled.health)) return finish();
    const opened = await source.openObservation();
    checks.push(check("the shadow's observation database opens for composite reads", opened.ok, opened.ok ? opened.value.tenant.namespace : opened.error.detail));
    if (!opened.ok) return finish();
    reads = opened.value;
    const open = reads;
    let answeredBeforeTasks: readonly MeasurementReadback[] = [];
    let beforeApproval: RelationCheckpoint | null = null;

    /** Every step's outcome stays in the report, whether or not the run could go on from it. */
    const kept = (step: (run: RunReference, target: string) => Promise<ProofCheck>) => async (run: RunReference, target: string): Promise<ProofCheck> => {
      const outcome = await step(run, target);
      checks.push(outcome);
      return outcome;
    };

    /** Before the analysis is accepted, so before any task can exist: measure it and pick the two findings. */
    const analysisAnswered: ReviewCheckpoint = { review: "analysis_review", before: kept(async (run) => {
      const read = await readUntil(io, run.run_id, "analysis-before-tasks", settledRun);
      measurements.push(...read);
      const spend = await readSpend(io, run.run_id, "analysis-before-tasks");
      const kinds = [...new Set((await runItems(io, run.run_id)).map((item) => item.item_kind))].sort();
      checks.push(...unlinkedAnalysisChecks(read, spend, kinds, plans.value.committed_plan));
      const findings = [...new Map(read.filter((measurement) => measurement.item_kind === "finding" && measurement.state === "answered")
        .map((measurement) => [measurement.occurrence_id, measurement])).values()].sort((left, right) => left.item_path.localeCompare(right.item_path, undefined, { numeric: true }));
      const [first] = findings;
      const last = findings.at(-1);
      if (!first || !last || first === last) return check("the analysis has two answered findings", false, `${findings.length} answered finding(s)`);
      linked = { occurrence_id: first.occurrence_id, revision_id: first.revision_id, item_path: first.item_path };
      control = { occurrence_id: last.occurrence_id, revision_id: last.revision_id, item_path: last.item_path };
      answeredBeforeTasks = read.filter((measurement) => measurement.occurrence_id === first.occurrence_id);
      checkpoints.push(await relationCheckpoint(io, { checkpoint: "answered-before-tasks", run_id: run.run_id, linked: first.occurrence_id, control: last.occurrence_id }));
      return check("the analysis has two answered findings", true, `linked ${first.revision_id}${first.item_path}, control ${last.revision_id}${last.item_path}`);
    }) };

    const mappingOf = (task_ids_to_link: readonly string[]) => ({ request_id: crypto.randomUUID(), tasks_revision_id,
      entries: [{ source_revision_id: linked?.revision_id, item_path: linked?.item_path, task_ids: task_ids_to_link }] });

    /** Around the tasks review: a mapping before its approval is refused, and approval alone links nothing. */
    const tasksApproved: ReviewCheckpoint = { review: "tasks_review",
      before: kept(async (run, target) => {
        tasks_revision_id = target;
        const early = await io.dbos(declareRoute(run.run_id), mappingOf(["T1"]));
        beforeApproval = await relationCheckpoint(io, { checkpoint: "before-tasks-approval", run_id: run.run_id, linked: linked?.occurrence_id ?? "", control: control?.occurrence_id ?? "" });
        checkpoints.push(beforeApproval);
        return check("a mapping naming an unapproved tasks revision is refused", !early.ok && early.error.detail.includes("409"), early.ok ? JSON.stringify(early.value) : early.error.detail);
      }),
      after: kept(async (run) => {
        const before = beforeApproval;
        if (!before || !linked || !control) return check("the tasks review had its before step", false, "no earlier checkpoint");
        // Everything the mapping names reaches observation in order, so it is delivered after the approval.
        let listed: Paged<LogicalItemComposite> = await composites(open, run.run_id);
        for (let attempt = 0; attempt < DELIVERY_ATTEMPTS && listed.total === 0; attempt++) { await io.sleep(POLL_MS); listed = await composites(open, run.run_id); }
        task_ids = listed.items.map((item) => item.producer_local_id);
        const [task] = task_ids;
        if (!task) return check("the approved task list was captured", false, "no logical task");
        const gap = listed.items.every((item) => item.coverage === "gap");
        readbacks.composite_after_approval = listed;
        const afterApproval = await relationCheckpoint(io, { checkpoint: "after-tasks-approval", run_id: run.run_id, linked: linked.occurrence_id, control: control.occurrence_id });
        checkpoints.push(afterApproval);
        checks.push(...unchangedChecks(before, afterApproval, "the approval"));
        checks.push(check("an approval alone creates no association: every task is a coverage gap", gap, `${listed.total} task(s)`));
        const mapping = mappingOf([task, UNRESOLVED_TASK]);
        const declared = await io.dbos(declareRoute(run.run_id), mapping);
        declarations.push({ checkpoint: "after-tasks-approval", request: mapping, response: declared.ok ? declared.value : declared.error.detail });
        const replay = await io.dbos(declareRoute(run.run_id), mapping);
        declarations.push({ checkpoint: "replay", response: replay.ok ? replay.value : replay.error.detail });
        checks.push(check("the replayed request answers with the same event", declared.ok && replay.ok
          && (declared.value as { event_id?: string }).event_id === (replay.value as { event_id?: string }).event_id, JSON.stringify(replay.ok ? replay.value : replay.error.detail)));
        const read = await untilLinked(io, open, run.run_id, task, "analysis");
        readbacks.composite_after_declaration = read;
        const after = await relationCheckpoint(io, { checkpoint: "after-declaration", run_id: run.run_id, linked: linked.occurrence_id, control: control.occurrence_id });
        checkpoints.push(after);
        checks.push(...unchangedChecks(afterApproval, after, "the link"));
        checks.push(...compositeOriginalAnswerChecks(read, answeredBeforeTasks, await answerObservations(open, run.run_id, read, "analysis")));
        readbacks.declarations_after_delivery = await readRelationDeclarations(open.db, open.tenant, run.run_id);
        const unlinked = await listRunUnlinkedItems(open.db, open.tenant, path, run.run_id, WHOLE);
        readbacks.unlinked_after_declaration = unlinked;
        checks.push(check("the control stays unlinked and readable", unlinked.items.some((item) => item.occurrence_id === control?.occurrence_id), `${unlinked.total} unlinked item(s)`));
        const unresolved = await listRunUnresolvedReferences(open.db, open.tenant, path, run.run_id, WHOLE);
        return check("the unknown task stays a visible reference", unresolved.items.some((reference) => reference.unresolved_target_ref === `logical_item:task:${UNRESOLVED_TASK}`), `${unresolved.total} reference(s)`);
      }) };

    const { report, run } = await source.run("links", { grading_enabled: true, through: "assessment", capture: "await", reviews: [analysisAnswered, tasksApproved] });
    const reached = report.status === "passed" && run !== null;
    checks.push(check("the links run reaches its assessment on the real stack", reached,
      report.checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`).join("; ") || run?.run_id || "no run"));
    if (run) runs.push(run);
    if (!run || !linked || !control || task_ids.length === 0) return finish();
    const addresses = { run_id: run.run_id, linked: (linked as FindingAddress).occurrence_id, control: (control as FindingAddress).occurrence_id };

    // The run was canceled at its assessment, so no agent is mid-turn when the stack stops.
    const graded = await readUntil(io, run.run_id, "assessment-settled", settledRun);
    measurements.push(...graded);
    const settledBefore = await relationCheckpoint(io, { ...addresses, checkpoint: "before-restart" });
    checkpoints.push(settledBefore);
    const status = await io.observationStatus();
    const pid = Number(/^pid_(\d+)$/.exec(status?.detail ?? "")?.[1]);
    checks.push(check("observation is killed before the second mapping", pid > 0, JSON.stringify(status)));
    if (!pid) return finish();
    io.killObservation(pid);
    for (let attempt = 0; attempt < DELIVERY_ATTEMPTS && (await io.kbblHealth())?.observation.state !== "down"; attempt++) await io.sleep(POLL_MS);
    const second = mappingOf([task_ids.at(-1) ?? ""]);
    const down = await io.dbos(declareRoute(run.run_id), second);
    declarations.push({ checkpoint: "observation-down", request: second, response: down.ok ? down.value : down.error.detail });
    checks.push(check("a mapping journals while observation is down: delivery cannot refuse it", down.ok, down.ok ? JSON.stringify(down.value) : down.error.detail));
    await io.stopStack();
    const restarted = await io.startStack();
    checks.push(check("the stack restarts before anything acknowledged the mapping", restarted.ok, restarted.ok ? "answered" : restarted.error.detail));
    if (!restarted.ok) return finish();
    const resettled = await settleObservation(io);
    checks.push(check("observation returns on the same state", observationSettled(resettled.health), `health ${resettled.health}; launcher ${resettled.launcher}`));
    let stored = await readRelationDeclarations(open.db, open.tenant, run.run_id);
    for (let attempt = 0; attempt < DELIVERY_ATTEMPTS && stored.length < 2; attempt++) { await io.sleep(POLL_MS); stored = await readRelationDeclarations(open.db, open.tenant, run.run_id); }
    readbacks.declarations_after_restart = stored;
    const distinctRelations = new Set(stored.flatMap((declaration) => declaration.projection.relation_ids));
    checks.push(check("each journaled declaration was delivered exactly once after the restart", stored.length === 2 && stored.every((declaration) => declaration.projection.unresolved_sources.length === 0),
      `${stored.length} declaration(s), ${distinctRelations.size} relation(s)`));
    const afterRestart = await relationCheckpoint(io, { ...addresses, checkpoint: "after-restart" });
    checkpoints.push(afterRestart);
    checks.push(...unchangedChecks(settledBefore, afterRestart, "the restart and replay"));
    checks.push(check("the only authority event the restart window added is the journaled mapping", settledBefore.authority_events !== null
      && afterRestart.authority_events === settledBefore.authority_events + 1, `${settledBefore.authority_events} then ${afterRestart.authority_events}`));
    measurements.push(...await readUntil(io, run.run_id, "after-restart", settledRun));

    const all = await composites(open, run.run_id);
    readbacks.composites_final = all;
    const task = all.items.find((item) => stageOf(item, "analysis")?.coverage === "linked" && stageOf(item, "implementation")?.coverage === "linked")
      ?? all.items.find((item) => stageOf(item, "analysis")?.coverage === "linked");
    checks.push(check("a task reads its analysis and implementation stages side by side, with integration pending",
      task !== undefined && stageOf(task, "analysis")?.coverage === "linked" && stageOf(task, "implementation")?.publication.state === "published"
        && stageOf(task, "integration")?.publication.state === "pending", JSON.stringify(task?.stages.map((stage) => [stage.stage, stage.publication.state, stage.coverage]) ?? null)));
    if (task) {
      checks.push(...await drilldownChecks(open, run.run_id, task));
      const lineage = await readLogicalItemLineage(open.db, open.tenant, path, run.run_id, task.producer_local_id, WHOLE);
      readbacks.lineage = lineage;
      checks.push(...lineageChecks(lineage));
    }
    readbacks.unlinked_final = await listRunUnlinkedItems(open.db, open.tenant, path, run.run_id, WHOLE);
    readbacks.unresolved_final = await listRunUnresolvedReferences(open.db, open.tenant, path, run.run_id, WHOLE);

    await sharedRun(io, source, open, { checks, runs, measurements, checkpoints, readbacks });

    // The shared-task matrix, in a tenant of its own.
    const matrix = await sharedTaskMatrix(open.db, { producer: open.tenant.producer, namespace: matrix_namespace }, plans.value.committed_plan);
    checks.push(...matrix.checks);
    readbacks.shared_task_matrix = matrix.reads;
    return finish();
  } catch (cause) {
    checks.push(check("the scenario completes", false, cause instanceof Error ? cause.message : String(cause)));
    return finish();
  } finally {
    await reads?.close();
    await io.stopStack();
  }
}
