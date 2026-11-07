/**
 * Automatic grading on the real shadow with real provider requests, continuing the registration
 * scenario with executions:
 *
 *   start on the committed selection -> an enabled run's analysis is answered by the configured
 *   provider before the run has any task -> a run with grading off gets human-ready evidence and
 *   sends nothing -> an enabled run captured while its launch repository is withheld answers its
 *   ready questions while file-citing ones wait -> edit graders.json (new instructions, and an
 *   estimate per call that lets one request fit the run allowance) and restart: the waits keep their
 *   pins and are not admitted -> supply the repository and restart: they are answered with the
 *   evaluators pinned at capture -> an enabled run captured under the edit is measured with the new
 *   evaluators, and the request that cannot fit is budget_deferred with no request -> restart: nothing
 *   is admitted or sent again -> point the provider at an endpoint that never answers, kill observation
 *   while a claim's request is in flight, and restart with a key the provider refuses: the expired
 *   claim is recovered, every refused request is recorded, retries are exhausted and no grade exists.
 *
 * Every run is a real development run on the same stack. Grades and provider failures write nothing
 * to Oakridge: each run's authority events are counted before and after its grading. graders.json,
 * the withheld repository and the provider settings are restored whatever happens.
 */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Result } from "../src/domain/primitives";
import type { GraderConfiguration, GradingRegistration } from "../src/grading/configuration";
import { configuredRunnerNames, credentialsForRunners, parseEnvFile } from "../src/grading/provider-credentials";
import { NO_EVIDENCE, scenarioStatus, type MeasurementReadback, type ProofCheck, type ProofFailure, type RegistrationReadback,
  type RunReference, type ScenarioReport, type SpendReadback } from "./proof-contract";
import { editedGraders, graderPlans, type RunLabel } from "./registration";
import { awaitRunCapture, runCaptureChecks } from "./run-capture";
import { observationSettled, settleObservation } from "./scenarios";
import type { ProofIo, StackOptions } from "./shadow-session";
import type { SourceRunTarget } from "./source-run";

const PAGE = 200;
const POLL_MS = 1_000;
const SETTLE_ATTEMPTS = 600;
const QUIET_MS = 40_000;
/** An address reserved for documentation (RFC 5737): a request to it is sent and never answered. */
const UNANSWERED_BASE_URL = "http://192.0.2.1/v1";
/** Configured estimate per call under the edit: one request fits the default $5 run allowance, a second does not. */
export const EDITED_ESTIMATE_PER_CALL = 3;

const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });

export type GradingRunLabel = RunLabel | "analysis-on" | "analysis-off" | "assessment-on" | "analysis-edited" | "analysis-failing";
export interface GradingRunOptions {
  readonly grading_enabled: boolean;
  readonly through: SourceRunTarget;
  readonly capture: "await" | "deferred";
  readonly after_launch?: (run: RunReference) => Promise<ProofCheck>;
}
/** The real runs and the one launch repository the scenario may withhold from observation. */
export interface GradingSource {
  run(label: GradingRunLabel, options: GradingRunOptions): Promise<{ readonly report: ScenarioReport; readonly run: RunReference | null }>;
  withholdRepository(): Promise<Result<string, ProofFailure>>;
  supplyRepository(): Promise<Result<string, ProofFailure>>;
}

/** The edit swapped in mid-scenario: new instructions, and an estimate that lets one request per run fit. */
export function gradingEdit(configuration: GraderConfiguration): GraderConfiguration {
  const edited = editedGraders(configuration);
  return { questions: edited.questions.map((entry) => ({ ...entry,
    graders: entry.graders.map((grader) => ({ ...grader, estimated_cost_per_call: EDITED_ESTIMATE_PER_CALL })) })) };
}

interface ServedItem { readonly occurrence_id: string; readonly revision_id: string; readonly json_pointer: string; readonly item_kind: string }
interface ServedMeasurements {
  readonly questions: readonly {
    readonly evidence: { readonly evidence_set_id: string; readonly question_id: string; readonly question_version: string;
      readonly readiness: { readonly state: "ready" | "not_ready" } };
    readonly is_human_ready: boolean;
    readonly machine: readonly { readonly evaluator_definition_id: string; readonly model: string | null; readonly execution_id: string | null;
      readonly measurement: { readonly state: string; readonly code?: string; readonly error?: string; readonly terminal_cause?: string | null;
        readonly status?: string; readonly observation_id?: string; readonly answer?: unknown };
      readonly attempts: MeasurementReadback["attempts"] }[];
  }[];
}

async function runItems(io: ProofIo, run_id: string): Promise<readonly ServedItem[]> {
  const items: ServedItem[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await io.observationGet(`/v1/runs/${encodeURIComponent(run_id)}/items?limit=${PAGE}&offset=${offset}`, "read");
    if (!page.ok) throw new Error(page.error.detail);
    const served = (page.value as { readonly items: readonly ServedItem[] }).items;
    items.push(...served);
    if (served.length < PAGE) return items;
  }
}

/** Every pinned machine measurement of a run's items, as the service serves them. */
export async function readRunMeasurements(io: ProofIo, run_id: string, checkpoint: string): Promise<readonly MeasurementReadback[]> {
  const readbacks: MeasurementReadback[] = [];
  for (const item of await runItems(io, run_id)) {
    const read = await io.observationGet(`/v1/items/${encodeURIComponent(item.occurrence_id)}/measurements`, "read");
    if (!read.ok) throw new Error(read.error.detail);
    for (const question of (read.value as ServedMeasurements).questions) for (const machine of question.machine) {
      const measurement = machine.measurement;
      readbacks.push({ checkpoint, run_id, occurrence_id: item.occurrence_id, revision_id: item.revision_id, item_path: item.json_pointer,
        item_kind: item.item_kind, question_id: question.evidence.question_id, question_version: question.evidence.question_version,
        evidence_set_id: question.evidence.evidence_set_id, readiness: question.evidence.readiness.state, is_human_ready: question.is_human_ready,
        evaluator_definition_id: machine.evaluator_definition_id, model: machine.model, execution_id: machine.execution_id, state: measurement.state,
        detail: measurement.code ?? measurement.status ?? measurement.error ?? null, observation_id: measurement.observation_id ?? null,
        answer: measurement.answer ?? null, attempts: machine.attempts });
    }
  }
  return readbacks;
}

export async function readSpend(io: ProofIo, run_id: string, checkpoint: string): Promise<SpendReadback> {
  const read = await io.observationGet(`/v1/runs/${encodeURIComponent(run_id)}/grading-spend`, "read");
  if (!read.ok) throw new Error(read.error.detail);
  const spend = read.value as { readonly is_grading_enabled: boolean; readonly committed: number; readonly requests_sent: number;
    readonly attempts: number; readonly executions: Readonly<Record<string, number>> };
  return { checkpoint, run_id, grading_enabled: spend.is_grading_enabled, committed: spend.committed, requests_sent: spend.requests_sent,
    attempts: spend.attempts, executions: spend.executions };
}

/** Still moving: collection not yet looked at, admission or a claim still to come. */
const isUnsettled = (measurement: MeasurementReadback): boolean => measurement.state === "pending" || measurement.state === "awaiting_admission"
  || (measurement.state === "not_ready" && measurement.detail === "collection_pending");
export const settledRun = (measurements: readonly MeasurementReadback[]): boolean =>
  measurements.length > 0 && !measurements.some(isUnsettled);

/** Reads until `done` holds or the attempts run out; the last read is returned either way. */
async function readUntil(io: ProofIo, run_id: string, checkpoint: string, done: (read: readonly MeasurementReadback[]) => boolean)
  : Promise<readonly MeasurementReadback[]> {
  let read: readonly MeasurementReadback[] = [];
  for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt++) {
    try { read = await readRunMeasurements(io, run_id, checkpoint); } catch { read = []; }
    if (done(read)) return read;
    await io.sleep(POLL_MS);
  }
  return read;
}

const countBy = (measurements: readonly MeasurementReadback[]): string => {
  const counts = new Map<string, number>();
  for (const measurement of measurements) counts.set(measurement.state, (counts.get(measurement.state) ?? 0) + 1);
  return [...counts].map(([state, count]) => `${count} ${state}`).join(", ") || "none";
};
const pinnedTo = (registration: GradingRegistration): ReadonlySet<string> =>
  new Set(registration.graders.map((grader) => grader.evaluator_definition_id));
const sentRequests = (measurement: MeasurementReadback): number => measurement.attempts.filter((attempt) => attempt.request_sent).length;

/** An enabled run's analysis: every ready question answered by a real request, before the run has any task. */
export function unlinkedAnalysisChecks(read: readonly MeasurementReadback[], spend: SpendReadback, kinds: readonly string[],
  committed: GradingRegistration): readonly ProofCheck[] {
  const answered = read.filter((measurement) => measurement.state === "answered");
  const committedIds = pinnedTo(committed);
  return [
    check("the enabled run committed grading on with its launch", spend.grading_enabled === true, `grading_enabled ${spend.grading_enabled}`),
    check("the run has no task when its analysis is graded", !kinds.includes("task"), `captured kinds: ${kinds.join(", ")}`),
    check("every analysis question is answered by the configured provider", read.length > 0 && answered.length === read.length
      && answered.every((measurement) => sentRequests(measurement) > 0), countBy(read)),
    check("each answer uses the evaluator pinned at capture", answered.length > 0 && answered.every((measurement) => committedIds.has(measurement.evaluator_definition_id)),
      [...new Set(answered.map((measurement) => measurement.evaluator_definition_id))].join(", ")),
    check("the run's request count is every real request it made", spend.requests_sent === read.reduce((total, measurement) => total + sentRequests(measurement), 0)
      && spend.requests_sent >= answered.length, `${spend.requests_sent} sent, ${spend.attempts} attempt(s), committed ${spend.committed}`),
  ];
}

/** A run with grading off: human-ready evidence and no request. */
export function offRunChecks(read: readonly MeasurementReadback[], spend: SpendReadback): readonly ProofCheck[] {
  const ready = read.filter((measurement) => measurement.readiness === "ready");
  return [
    check("the off run committed grading off with its launch", spend.grading_enabled === false, `grading_enabled ${spend.grading_enabled}`),
    check("its ready questions are human-ready and read as grading off", ready.length > 0
      && ready.every((measurement) => measurement.is_human_ready && measurement.state === "grading_off"), countBy(read)),
    check("it sends no provider request and admits nothing", spend.requests_sent === 0 && spend.attempts === 0
      && Object.values(spend.executions).every((count) => count === 0), JSON.stringify(spend)),
  ];
}

/** Captured with the repository withheld: ready questions answered, file-citing ones waiting with no execution. */
export function waitingCaptureChecks(read: readonly MeasurementReadback[]): readonly ProofCheck[] {
  const waiting = read.filter((measurement) => measurement.state === "not_ready");
  const answered = read.filter((measurement) => measurement.state === "answered");
  const split = new Set(waiting.map((measurement) => measurement.occurrence_id));
  const beside = answered.filter((measurement) => split.has(measurement.occurrence_id)).length;
  return [
    check("a required lookup waits at capture and nothing is admitted for it", waiting.length > 0 && waiting.every((measurement) => measurement.execution_id === null),
      `${waiting.length} waiting (${[...new Set(waiting.map((measurement) => measurement.detail))].join(",")})`),
    check("ready questions are answered while others wait", answered.length > 0,
      `${countBy(read)}; ${beside} answer(s) beside a waiting question of the same item`),
  ];
}

/** After the input arrives: every waited question answered with the evaluator pinned before the edit. */
export function pinnedArrivalChecks(waited: readonly MeasurementReadback[], read: readonly MeasurementReadback[],
  committed: GradingRegistration, edited: GradingRegistration): readonly ProofCheck[] {
  const now = new Map(read.map((measurement) => [`${measurement.evidence_set_id} ${measurement.evaluator_definition_id}`, measurement]));
  const arrived = waited.flatMap((measurement) => { const later = now.get(`${measurement.evidence_set_id} ${measurement.evaluator_definition_id}`);
    return later ? [later] : []; });
  const answered = arrived.filter((measurement) => measurement.state === "answered");
  const committedIds = pinnedTo(committed);
  const editedIds = pinnedTo(edited);
  return [
    check("every question that waited is answered once its input arrives", waited.length > 0 && answered.length === waited.length,
      `${answered.length} of ${waited.length} answered (${countBy(arrived)})`),
    check("their first answers use the evaluators pinned at capture, not the edit", answered.length > 0
      && answered.every((measurement) => committedIds.has(measurement.evaluator_definition_id) && !editedIds.has(measurement.evaluator_definition_id)),
      [...new Set(answered.map((measurement) => measurement.model))].join(", ")),
  ];
}

/** A run captured under the edit: measured with the new evaluators; what cannot fit is deferred without a request. */
export function editedRunChecks(read: readonly MeasurementReadback[], spend: SpendReadback, edited: GradingRegistration): readonly ProofCheck[] {
  const editedIds = pinnedTo(edited);
  const deferred = read.filter((measurement) => measurement.state === "budget_deferred");
  const answered = read.filter((measurement) => measurement.state === "answered");
  return [
    check("a later capture is measured with the edited evaluators", read.length > 0 && read.every((measurement) => editedIds.has(measurement.evaluator_definition_id)),
      [...new Set(read.map((measurement) => measurement.model))].join(", ")),
    check("one request fits the run allowance and is answered", answered.length === 1 && answered.every((measurement) => sentRequests(measurement) === 1),
      countBy(read)),
    check("what cannot fit is budget_deferred, with no request and no answer", deferred.length > 0
      && deferred.every((measurement) => measurement.attempts.length === 0 && measurement.observation_id === null),
      `${deferred.length} deferred; run spend ${spend.committed} in ${spend.requests_sent} request(s)`),
  ];
}

/** The expired claim recovered, every refused request recorded, retries exhausted and no grade written. */
export function failureChecks(read: readonly MeasurementReadback[], spend: SpendReadback): readonly ProofCheck[] {
  const ready = read.filter((measurement) => measurement.readiness === "ready");
  const recovered = ready.filter((measurement) => measurement.attempts.some((attempt) => attempt.failure_category === "lease_expired" && attempt.request_sent));
  const refused = ready.flatMap((measurement) => measurement.attempts).filter((attempt) => attempt.failure_category === "http_error" && attempt.request_sent);
  return [
    check("an expired claim whose request was in flight is reclaimed, its request kept as a retry", recovered.length > 0,
      `${recovered.length} recovered: ${recovered.map((measurement) => measurement.execution_id).join(", ")}`),
    check("the provider's refusals are real requests, each recorded", refused.length > 0, `${refused.length} refused request(s)`),
    check("retries are exhausted and the executions end failed with no grade", ready.length > 0
      && ready.every((measurement) => measurement.state === "failed" && measurement.observation_id === null), countBy(read)),
    check("the run's request count covers every real request", spend.requests_sent === ready.reduce((total, measurement) => total + sentRequests(measurement), 0),
      `${spend.requests_sent} sent in ${spend.attempts} attempt(s)`),
  ];
}

/** Settings for every runner graders.json selects, from the shadow's real provider file: the key replaced, or the endpoint moved. */
async function providerVariant(io: ProofIo, directory: string, name: string, change: (setting: string, value: string) => string | null)
  : Promise<string> {
  const runners = configuredRunnerNames(JSON.parse(await io.readGraders()));
  if (!runners.ok) throw new Error(runners.error.detail);
  const credentials = credentialsForRunners(runners.value);
  if (!credentials.ok) throw new Error(credentials.error.detail);
  const real = parseEnvFile(await Bun.file(io.state.provider_env_file).text());
  const lines = [...credentials.value.required, ...credentials.value.optional].flatMap((setting) => {
    const value = change(setting, real.get(setting) ?? "");
    return value === null || value === "" ? [] : [`${setting}=${value}`];
  });
  const path = join(directory, name);
  await Bun.write(path, lines.join("\n") + "\n");
  await chmod(path, 0o600);
  return path;
}

async function authorityEvents(io: ProofIo, run_id: string): Promise<number | null> {
  if (!/^[\w.:/-]+$/.test(run_id)) return null;
  const counted = await io.shadowQuery(io.state.postgres.authority_database, `SELECT count(*) FROM authority.event WHERE run_id = '${run_id}'`);
  return counted.ok ? Number(counted.value) : null;
}

export async function gradingScenario(io: ProofIo, source: GradingSource): Promise<ScenarioReport> {
  if (await io.stackAnswers()) return { id: "grading", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("this proof owns the stack", false, "a shadow is already running; this proof restarts it with edited settings")] };
  const original = await io.readGraders();
  const plans = graderPlans(original);
  if (!plans.ok) return { id: "grading", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("graders.json and its edit plan a registration", false, `${plans.error.entity_id}: ${plans.error.detail}`)] };
  const edit = gradingEdit(plans.value.committed);
  const edited_plan = graderPlans(JSON.stringify(edit));
  if (!edited_plan.ok) return { id: "grading", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("the edit plans a registration", false, edited_plan.error.detail)] };
  const committed = plans.value.committed_plan;
  const edited = edited_plan.value.committed_plan;
  const checks: ProofCheck[] = [];
  const runs: RunReference[] = [];
  const measurements: MeasurementReadback[] = [];
  const spend: SpendReadback[] = [];
  const registrations: RegistrationReadback[] = [];
  const directory = await mkdtemp(join(tmpdir(), "oakridge-grading-proof-"));
  const evidence = () => {
    const latest = new Map<string, MeasurementReadback>();
    for (const measurement of measurements) latest.set(`${measurement.evidence_set_id} ${measurement.evaluator_definition_id}`, measurement);
    const final = [...latest.values()];
    return { ...NO_EVIDENCE, runs, registrations, measurements, spend,
      source_revisions: [...new Set(final.map((measurement) => measurement.revision_id))],
      item_paths: [...new Set(final.map((measurement) => `${measurement.revision_id}${measurement.item_path}`))],
      pinned_definitions: [...new Set(final.map((measurement) => measurement.evaluator_definition_id))],
      execution_ids: [...new Set(final.flatMap((measurement) => measurement.execution_id ? [measurement.execution_id] : []))],
      provider_attempt_ids: final.flatMap((measurement) => measurement.attempts.map((attempt) => `${measurement.execution_id}#${attempt.attempt}`)),
      observation_ids: final.flatMap((measurement) => measurement.observation_id ? [measurement.observation_id] : []),
      provider_request_count: final.reduce((total, measurement) => total + sentRequests(measurement), 0) };
  };
  const finish = (): ScenarioReport => ({ id: "grading", status: scenarioStatus(checks), checks, evidence: evidence() });
  const startOn = async (checkpoint: string, registration: GradingRegistration, options: StackOptions = {}): Promise<boolean> => {
    const started = await io.startStack(options);
    checks.push(check(`the stack starts (${checkpoint})`, started.ok, started.ok ? "answered" : started.error.detail));
    if (!started.ok) return false;
    const settled = await settleObservation(io);
    const health = await io.kbblHealth();
    const graders = health?.observation.state === "configured" ? health.observation.graders.map((grader) => grader.evaluatorDefinitionId) : [];
    registrations.push({ checkpoint, graders: health?.observation.state === "configured"
      ? health.observation.graders.map((grader) => ({ runner: grader.runner, evaluator_definition_id: grader.evaluatorDefinitionId })) : [],
    stored_evaluator_definition_ids: [] });
    const expected = registration.graders.map((grader) => grader.evaluator_definition_id);
    checks.push(check(`observation is up with the configured graders (${checkpoint})`, observationSettled(settled.health)
      && JSON.stringify([...graders].sort()) === JSON.stringify([...expected].sort()), `health ${settled.health}; launcher ${settled.launcher}`));
    return observationSettled(settled.health);
  };
  const runTo = async (label: GradingRunLabel, options: GradingRunOptions): Promise<RunReference | null> => {
    const { report, run } = await source.run(label, options);
    const passed = report.status === "passed" && run !== null;
    checks.push(check(`the ${label} run reaches its ${options.through} on the real stack`, passed,
      report.checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`).join("; ") || run?.run_id || "no run"));
    if (run) runs.push(run);
    return passed ? run : null;
  };
  const settle = async (run_id: string, checkpoint: string, done: (read: readonly MeasurementReadback[]) => boolean = settledRun) => {
    const read = await readUntil(io, run_id, checkpoint, done);
    measurements.push(...read);
    spend.push(await readSpend(io, run_id, checkpoint));
    return { read, spend: spend.at(-1)! };
  };
  const stopObservation = async (name: string): Promise<ProofCheck> => {
    const status = await io.observationStatus();
    const pid = Number(/^pid_(\d+)$/.exec(status?.detail ?? "")?.[1]);
    if (!pid) return check(name, false, `no running service recorded: ${JSON.stringify(status)}`);
    io.killObservation(pid);
    let health = await io.kbblHealth();
    for (let attempt = 0; attempt < SETTLE_ATTEMPTS && health?.observation.state !== "down"; attempt++) {
      await io.sleep(POLL_MS);
      health = await io.kbblHealth();
    }
    const dbos = await io.dbosHealthy();
    return check(name, health?.observation.state === "down" && dbos, `kbbl observation ${JSON.stringify(health?.observation ?? null)}; DBOS healthy ${dbos}`);
  };
  try {
    // 1. An enabled run's analysis, answered before the run has any task.
    if (!await startOn("committed", committed)) return finish();
    const on = await runTo("analysis-on", { grading_enabled: true, through: "analysis", capture: "await" });
    if (!on) return finish();
    const onEvents = await authorityEvents(io, on.run_id);
    const onRead = await settle(on.run_id, "analysis-on");
    const kinds = [...new Set((await runItems(io, on.run_id)).map((item) => item.item_kind))].sort();
    checks.push(...unlinkedAnalysisChecks(onRead.read, onRead.spend, kinds, committed));
    checks.push(check("answers write no Oakridge authority record", onEvents !== null && await authorityEvents(io, on.run_id) === onEvents,
      `${onEvents} authority event(s) before and after grading`));

    // 2. Grading off: evidence for a reviewer, nothing sent.
    const off = await runTo("analysis-off", { grading_enabled: false, through: "analysis", capture: "await" });
    if (!off) return finish();
    const offRead = await settle(off.run_id, "analysis-off", (read) => read.length > 0
      && read.every((measurement) => !(measurement.state === "not_ready" && measurement.detail === "collection_pending")));
    checks.push(...offRunChecks(offRead.read, offRead.spend));

    // 3. Captured while its repository is withheld: ready questions answered, the rest wait.
    const assessed = await runTo("assessment-on", { grading_enabled: true, through: "assessment", capture: "deferred",
      after_launch: () => stopObservation("observation is down while the assessed run progresses, and DBOS keeps serving") });
    await io.stopStack();
    if (!assessed) return finish();
    const withheld = await source.withholdRepository();
    checks.push(check("the assessed run's launch repository is withheld from observation", withheld.ok, withheld.ok ? withheld.value : withheld.error.detail));
    if (!withheld.ok || !await startOn("committed, repository withheld", committed)) return finish();
    checks.push(...runCaptureChecks(await awaitRunCapture(io, { run_id: assessed.run_id, target_artifact: "assessment" })));
    const atCapture = await settle(assessed.run_id, "assessment-at-capture");
    checks.push(...waitingCaptureChecks(atCapture.read));
    const waited = atCapture.read.filter((measurement) => measurement.state === "not_ready");
    await io.stopStack();

    // 4. The edit and a restart: the waits keep their pins and nothing more is admitted or sent.
    await io.writeGraders(JSON.stringify(edit, null, 2) + "\n");
    if (!await startOn("edited, repository withheld", edited)) return finish();
    await io.sleep(QUIET_MS);
    const afterEdit = await settle(assessed.run_id, "assessment-after-edit");
    const stillWaiting = afterEdit.read.filter((measurement) => waited.some((earlier) => earlier.evidence_set_id === measurement.evidence_set_id
      && earlier.evaluator_definition_id === measurement.evaluator_definition_id && measurement.state === "not_ready" && measurement.execution_id === null));
    checks.push(check("questions waiting on a withheld input still wait through the edit and restart, unadmitted",
      waited.length > 0 && stillWaiting.length === waited.length, `${stillWaiting.length} of ${waited.length} still waiting`));
    checks.push(check("the restart sends nothing already answered again", afterEdit.spend.requests_sent === atCapture.spend.requests_sent,
      `${atCapture.spend.requests_sent} then ${afterEdit.spend.requests_sent} request(s)`));
    await io.stopStack();

    // 5. The input arrives: the waits are answered with their original evaluators.
    const supplied = await source.supplyRepository();
    checks.push(check("the withheld repository is supplied", supplied.ok, supplied.ok ? supplied.value : supplied.error.detail));
    if (!supplied.ok || !await startOn("edited, repository supplied", edited)) return finish();
    const waitedKeys = new Set(waited.map((measurement) => `${measurement.evidence_set_id} ${measurement.evaluator_definition_id}`));
    const arrival = await settle(assessed.run_id, "assessment-after-arrival", (read) => settledRun(read)
      && read.every((measurement) => !waitedKeys.has(`${measurement.evidence_set_id} ${measurement.evaluator_definition_id}`) || measurement.state !== "not_ready"));
    checks.push(...pinnedArrivalChecks(waited, arrival.read, committed, edited));

    // 6. A later capture under the edit: new evaluators, and one request per run allowance.
    const later = await runTo("analysis-edited", { grading_enabled: true, through: "analysis", capture: "await" });
    if (!later) return finish();
    const laterRead = await settle(later.run_id, "analysis-edited");
    checks.push(...editedRunChecks(laterRead.read, laterRead.spend, edited));

    // 7. Restart: nothing is admitted or sent again for any run.
    const before = await Promise.all(runs.map((run) => readSpend(io, run.run_id, "before-restart")));
    await io.stopStack();
    if (!await startOn("edited, restarted", edited)) return finish();
    await io.sleep(QUIET_MS);
    const after = await Promise.all(runs.map((run) => readSpend(io, run.run_id, "after-restart")));
    spend.push(...before, ...after);
    const moved = runs.filter((_, index) => before[index]!.requests_sent !== after[index]!.requests_sent
      || JSON.stringify(before[index]!.executions) !== JSON.stringify(after[index]!.executions));
    checks.push(check("a restart admits, sends and regrades nothing", moved.length === 0,
      moved.length === 0 ? `${runs.length} run(s) unchanged` : moved.map((run) => run.run_id).join(", ")));
    await io.stopStack();

    // 8. A provider that never answers, an observation killed mid-request, and a key the provider refuses.
    await io.writeGraders(original);
    const unanswered = await providerVariant(io, directory, "provider-unanswered.env", (setting, value) =>
      setting.endsWith("_BASE_URL") ? UNANSWERED_BASE_URL : value);
    const refused = await providerVariant(io, directory, "provider-refused.env", (setting, value) =>
      setting.endsWith("_BASE_URL") ? (value || null) : "oakridge-proof-refused-key");
    if (!await startOn("committed, provider unanswered", committed, { provider_env_file: unanswered })) return finish();
    const failing = await runTo("analysis-failing", { grading_enabled: true, through: "analysis", capture: "await" });
    if (!failing) return finish();
    const inFlight = await settle(failing.run_id, "failing-in-flight", (read) => read.some((measurement) => measurement.detail === "claimed"
      && measurement.attempts.some((attempt) => attempt.request_sent && attempt.outcome === null)));
    checks.push(check("a claim's request is in flight", inFlight.read.some((measurement) => measurement.detail === "claimed"), countBy(inFlight.read)));
    const failingEvents = await authorityEvents(io, failing.run_id);
    checks.push(await stopObservation("observation is killed mid-request while DBOS keeps serving"));
    await io.stopStack();
    if (!await startOn("committed, provider refuses the key", committed, { provider_env_file: refused })) return finish();
    const exhausted = await settle(failing.run_id, "failing-exhausted", (read) => read.length > 0
      && read.filter((measurement) => measurement.readiness === "ready").every((measurement) => measurement.state === "failed"));
    checks.push(...failureChecks(exhausted.read, exhausted.spend));
    checks.push(check("provider failures write no Oakridge authority record", failingEvents !== null && await authorityEvents(io, failing.run_id) === failingEvents,
      `${failingEvents} authority event(s) before and after the failures`));
    return finish();
  } catch (cause) {
    checks.push(check("the scenario completes", false, cause instanceof Error ? cause.message : String(cause)));
    return finish();
  } finally {
    await io.stopStack();
    await io.writeGraders(original);
    await source.supplyRepository();
    await rm(directory, { recursive: true, force: true });
  }
}
