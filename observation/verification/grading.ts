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
 *   claim is recovered, every refused request is recorded, retries are exhausted and no grade exists ->
 *   under an edit whose estimate lets two requests fit a run, kill observation while its claim's request
 *   is in flight and act as a second observation worker on the shadow's own database: simultaneous
 *   claims at the allowance's edge, a reclaim after lease expiry, refusal of every stale claim's writes,
 *   and a real request settled by the second worker -> restart: its answer is served and nothing more
 *   is sent.
 *
 * At every checkpoint the proof keeps each run's captured launch config beside the authority's, every
 * question and evaluator pin, and the frozen evidence references; a missing readback fails the proof.
 * Every run is a real development run on the same stack. Grades and provider failures write nothing
 * to Oakridge: each run's authority events are counted before and after its grading. graders.json,
 * the withheld repository and the provider settings are restored whatever happens.
 */
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest } from "canonical-json";
import type { JsonValue, Result } from "../src/domain/primitives";
import { fitsRunAllowance } from "../src/grading/budget";
import type { GraderConfiguration, GradingRegistration } from "../src/grading/configuration";
import type { ClaimResult, ExecutionClaim, SettlementResult } from "../src/grading/execution";
import { configuredRunnerNames, credentialsForRunners, parseEnvFile } from "../src/grading/provider-credentials";
import { settleClaim, type RunnerResolver } from "../src/grading/worker";
import { withTenant, type Database, type TenantScope } from "../src/storage/database";
import { claimNext, completeExecution, failExecution, markRequestSent, readRunSpend, type RunSpend } from "../src/storage/execution-store";
import { NO_EVIDENCE, scenarioStatus, type ClaimReadback, type FrozenEvidenceReadback, type LaunchConfigReadback, type MeasurementReadback,
  type PinReadback, type ProofCheck, type ProofFailure, type RegistrationReadback, type RunReference, type ScenarioReport,
  type SecondWorkerReadback, type SpendReadback, type StaleSettlementReadback } from "./proof-contract";
import { editedGraders, graderPlans, readRunPins, type RunLabel } from "./registration";
import { awaitRunCapture, runCaptureChecks } from "./run-capture";
import { observationSettled, settleObservation } from "./scenarios";
import type { ProofIo, StackOptions } from "./shadow-session";
import type { ReviewCheckpoint, SourceRunTarget, SourceRunInput } from "./source-run";

const PAGE = 200;
const POLL_MS = 1_000;
const SETTLE_ATTEMPTS = 600;
const QUIET_MS = 40_000;
/** An address reserved for documentation (RFC 5737): a request to it is sent and never answered. */
const UNANSWERED_BASE_URL = "http://192.0.2.1/v1";
/** Configured estimate per call under the edit: one request fits the default $5 run allowance, a second does not. */
export const EDITED_ESTIMATE_PER_CALL = 3;
/** Configured estimate per call for the second-worker step: two requests fit the default $5 run allowance, a third does not. */
export const CONCURRENT_ESTIMATE_PER_CALL = 2;

const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });

export type GradingRunLabel = RunLabel | "analysis-on" | "analysis-off" | "assessment-on" | "analysis-edited" | "analysis-failing"
  | "analysis-concurrent" | "links" | "shared";
export interface GradingRunOptions {
  readonly grading_enabled: boolean;
  readonly through: SourceRunTarget;
  readonly capture: "await" | "deferred";
  readonly after_launch?: (run: RunReference) => Promise<ProofCheck>;
  readonly reviews?: readonly ReviewCheckpoint[];
  /** Another input than the proof's own, for a run that needs a different plan. */
  readonly input?: SourceRunInput;
  readonly target_units?: number;
  readonly timeout_ms?: number;
}
/**
 * A second observation worker on the shadow's own database, as a second observation process would
 * be: the same store and worker code, the shadow's tenant, its validated default controls, and
 * runners built from the shadow's real provider settings.
 */
export interface SecondWorker {
  readonly db: Database;
  readonly tenant: TenantScope;
  readonly run_spend: number;
  readonly lease_ms: number;
  readonly runners: RunnerResolver;
  close(): Promise<void>;
}
/** The real runs, the one launch repository the scenario may withhold from observation, and a second worker. */
export interface GradingSource {
  run(label: GradingRunLabel, options: GradingRunOptions): Promise<{ readonly report: ScenarioReport; readonly run: RunReference | null }>;
  withholdRepository(): Promise<Result<string, ProofFailure>>;
  supplyRepository(): Promise<Result<string, ProofFailure>>;
  secondWorker(): Promise<Result<SecondWorker, ProofFailure>>;
}

/** The committed instructions with an estimate that lets exactly two requests of a run fit. */
export function concurrencyEdit(configuration: GraderConfiguration): GraderConfiguration {
  return { questions: configuration.questions.map((entry) => ({ ...entry,
    graders: entry.graders.map((grader) => ({ ...grader, estimated_cost_per_call: CONCURRENT_ESTIMATE_PER_CALL })) })) };
}

/** The edit swapped in mid-scenario: new instructions, and an estimate that lets one request per run fit. */
export function gradingEdit(configuration: GraderConfiguration): GraderConfiguration {
  const edited = editedGraders(configuration);
  return { questions: edited.questions.map((entry) => ({ ...entry,
    graders: entry.graders.map((grader) => ({ ...grader, estimated_cost_per_call: EDITED_ESTIMATE_PER_CALL })) })) };
}

interface ServedItem { readonly occurrence_id: string; readonly revision_id: string; readonly json_pointer: string; readonly item_kind: string }
interface ServedMeasurements {
  readonly questions: { readonly items: readonly {
    readonly evidence: { readonly evidence_set_id: string; readonly question_id: string; readonly question_version: string;
      readonly readiness: { readonly state: "ready" | "not_ready" } };
    readonly human: { readonly state: string };
    readonly machine: { readonly items: readonly { readonly evaluator_definition_id: string; readonly model: string | null; readonly execution_id: string | null;
      readonly measurement: { readonly state: string; readonly code?: string; readonly error?: string; readonly terminal_cause?: string | null;
        readonly status?: string; readonly observation_id?: string; readonly answer?: unknown };
      readonly attempts: { readonly items: MeasurementReadback["attempts"] } }[] };
  }[] };
}

export async function runItems(io: ProofIo, run_id: string): Promise<readonly ServedItem[]> {
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
    const read = await io.observationGet(`/v1/items/${encodeURIComponent(item.occurrence_id)}/status?limit=200&machine_limit=200&attempts_limit=200`, "read");
    if (!read.ok) throw new Error(read.error.detail);
    for (const question of (read.value as ServedMeasurements).questions.items) for (const machine of question.machine.items) {
      const measurement = machine.measurement;
      readbacks.push({ checkpoint, run_id, occurrence_id: item.occurrence_id, revision_id: item.revision_id, item_path: item.json_pointer,
        item_kind: item.item_kind, question_id: question.evidence.question_id, question_version: question.evidence.question_version,
        evidence_set_id: question.evidence.evidence_set_id, readiness: question.evidence.readiness.state, is_human_ready: question.human.state === "ready",
        evaluator_definition_id: machine.evaluator_definition_id, model: machine.model, execution_id: machine.execution_id, state: measurement.state,
        detail: measurement.code ?? measurement.status ?? measurement.error ?? null, observation_id: measurement.observation_id ?? null,
        answer: measurement.answer ?? null, attempts: machine.attempts.items });
    }
  }
  return readbacks;
}

export async function readSpend(io: ProofIo, run_id: string, checkpoint: string): Promise<SpendReadback> {
  const read = await io.observationGet(`/v1/runs/${encodeURIComponent(run_id)}/grading-spend`, "read");
  if (!read.ok) throw new Error(read.error.detail);
  const spend = read.value as { readonly is_grading_enabled: boolean; readonly captured_config: unknown; readonly committed: number;
    readonly requests_sent: number; readonly attempts: number; readonly executions: Readonly<Record<string, number>> };
  return { checkpoint, run_id, grading_enabled: spend.is_grading_enabled, captured_config: spend.captured_config, committed: spend.committed,
    requests_sent: spend.requests_sent, attempts: spend.attempts, executions: spend.executions };
}
/** The same readback taken by a second worker straight from the store the route serves. */
const spendReadback = (spend: RunSpend, checkpoint: string): SpendReadback => ({ checkpoint, run_id: spend.run_id,
  grading_enabled: spend.is_grading_enabled, captured_config: spend.captured_config, committed: spend.committed,
  requests_sent: spend.requests_sent, attempts: spend.attempts, executions: spend.executions });

/** Still moving: collection not yet looked at, admission or a claim still to come. */
const isUnsettled = (measurement: MeasurementReadback): boolean => measurement.state === "pending" || measurement.state === "awaiting_admission"
  || (measurement.state === "not_ready" && measurement.detail === "collection_pending");
export const settledRun = (measurements: readonly MeasurementReadback[]): boolean =>
  measurements.length > 0 && !measurements.some(isUnsettled);

/** Reads until `done` holds or the attempts run out; the last read is returned either way. */
export async function readUntil(io: ProofIo, run_id: string, checkpoint: string, done: (read: readonly MeasurementReadback[]) => boolean)
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

const digestOf = (value: unknown): string => {
  const digest = canonicalDigest(value as JsonValue);
  return digest.ok ? digest.value : JSON.stringify(value);
};

interface ConfigShape { readonly sessions?: unknown; readonly grading_enabled?: unknown }
/** The config observation captured from the launch delivery is the one the authority committed. A
 * committed config with no grading choice has grading off, and one with no sessions overrides none. */
export function launchConfigCheck(read: LaunchConfigReadback, grading_enabled: boolean, label: string): ProofCheck {
  const captured = read.captured_config as ConfigShape | null;
  const authority = read.authority_config as ConfigShape | null;
  const same = captured !== null && authority !== null && captured.grading_enabled === (authority.grading_enabled === true)
    && digestOf(captured.sessions ?? null) === digestOf(authority.sessions ?? {});
  return check(`the ${label} run's captured launch config is exactly the one the authority committed`,
    same && captured?.grading_enabled === grading_enabled,
    `captured grading_enabled ${String(captured?.grading_enabled)}, committed ${String(authority?.grading_enabled)}; sessions ${same ? "equal" : "differ"}`);
}

/** Every measurement read at a checkpoint has its question and evaluator pin, and every ready question its frozen references. */
export function pinReadbackChecks(checkpoint: string, measurements: readonly MeasurementReadback[], pins: readonly PinReadback[],
  frozen: readonly FrozenEvidenceReadback[]): readonly ProofCheck[] {
  const bySet = new Map(pins.map((pin) => [pin.evidence_set_id, pin]));
  const unpinned = measurements.filter((measurement) => {
    const pin = bySet.get(measurement.evidence_set_id);
    return !pin || pin.question_id !== measurement.question_id || pin.question_version !== measurement.question_version
      || !pin.pinned_evaluator_definition_ids.includes(measurement.evaluator_definition_id);
  });
  const withReferences = new Set(frozen.filter((entry) => entry.references.length > 0).map((entry) => entry.evidence_set_id));
  const ready = pins.filter((pin) => pin.readiness === "ready");
  const unfrozen = ready.filter((pin) => !withReferences.has(pin.evidence_set_id) || pin.references.length === 0);
  return [
    check(`every measurement at ${checkpoint} reads back its question and evaluator pins`, measurements.length > 0 && unpinned.length === 0,
      `${pins.length} pin(s) for ${measurements.length} measurement(s); ${unpinned.length} without a matching pin`),
    check(`every ready question at ${checkpoint} reads back its frozen evidence references`, ready.length > 0 && unfrozen.length === 0,
      `${ready.length} ready; ${unfrozen.length} without frozen references`),
  ];
}

const claimReadback = (worker: string, result: ClaimResult): ClaimReadback => ({ worker, kind: result.kind,
  execution_id: result.kind === "claimed" ? result.claim.execution_id : result.kind === "idle" ? null : result.execution_id,
  claim_attempt: result.kind === "claimed" ? result.claim.claim_attempt : null });
const settlementKind = (result: Result<SettlementResult, { readonly detail: string }>): string =>
  result.ok ? result.value.kind : `error: ${result.error.detail}`;

/** The run's open claim, as the killed service left it. */
async function openClaim(worker: SecondWorker, run_id: string): Promise<ExecutionClaim | null> {
  const row = await withTenant(worker.db, worker.tenant, (trx) => trx.selectFrom("observation.evaluation_execution")
    .select(["execution_id", "run_id", "lease_owner", "attempts", "lease_expires_at"]).where("producer", "=", worker.tenant.producer)
    .where("namespace", "=", worker.tenant.namespace).where("run_id", "=", run_id).where("status", "=", "claimed").executeTakeFirst());
  return row?.lease_owner && row.lease_expires_at ? { execution_id: row.execution_id as ExecutionClaim["execution_id"], run_id: row.run_id,
    lease_owner: row.lease_owner, claim_attempt: row.attempts, lease_expires_at: row.lease_expires_at } : null;
}

/** Presents a claim that is no longer current to every fenced write, as a stale worker finishing late would. */
async function staleSettlement(worker: SecondWorker, claim: ExecutionClaim, kind: StaleSettlementReadback["case"]): Promise<StaleSettlementReadback> {
  const mark_request_sent = await markRequestSent(worker.db, worker.tenant, claim);
  // "unclear" is an allowed answer of every supported question, so only the fence can refuse it.
  const complete = await completeExecution(worker.db, worker.tenant, claim, { answer: { state: "answered", kind: "choice", value: "unclear" } });
  const fail = await failExecution(worker.db, worker.tenant, claim, { category: "timeout", detail: "a stale worker's late failure",
    provider_request_id: null, provider_cost: null });
  return { case: kind, execution_id: claim.execution_id, lease_owner: claim.lease_owner, claim_attempt: claim.claim_attempt,
    mark_request_sent, complete: settlementKind(complete), fail: settlementKind(fail) };
}

/**
 * With the service killed while its claim's request is in flight, a second worker on the same
 * database: as many simultaneous claims as there is due work and more, each against the one run
 * allowance; once every claim has expired, a reclaim by another worker; every stale claim presented
 * to every fenced write; and the reclaimed execution measured with a real request.
 */
export async function secondWorkerPhase(io: ProofIo, worker: SecondWorker, run_id: string, estimate_per_call: number): Promise<SecondWorkerReadback> {
  const spendNow = async (checkpoint: string) => spendReadback(await readRunSpend(worker.db, worker.tenant, run_id), checkpoint);
  const service = await openClaim(worker, run_id);
  const before = await spendNow("second-worker-before");
  const due = (before.executions.queued ?? 0) + (before.executions.reclaimable ?? 0);
  const controls = { lease_ms: worker.lease_ms, run_spend: worker.run_spend };
  const simultaneous = await Promise.all(Array.from({ length: due + 2 }, (_, index) => `proof-second-worker-${index}`)
    .map(async (lease_owner) => ({ lease_owner, result: await claimNext(worker.db, worker.tenant, { ...controls, lease_owner }) })));
  const after_claims = await spendNow("second-worker-after-claims");
  const contested = simultaneous.flatMap(({ result }) => result.kind === "claimed" ? [result.claim] : [])[0] ?? null;
  const reclaims: ClaimReadback[] = [];
  const stale: StaleSettlementReadback[] = [];
  let settlement: SecondWorkerReadback["settlement"] = null;
  if (contested) {
    // Every claim taken so far, the killed service's included, expires before the reclaim.
    await io.sleep(Math.max(0, new Date(contested.lease_expires_at).getTime() - io.now()) + 2_000);
    const reclaimer = "proof-second-worker-reclaimer";
    let reclaimed: ExecutionClaim | null = null;
    for (let attempt = 0; attempt < due + 2 && !reclaimed; attempt++) {
      const result = await claimNext(worker.db, worker.tenant, { ...controls, lease_owner: reclaimer });
      reclaims.push(claimReadback(reclaimer, result));
      if (result.kind === "idle") break;
      if (result.kind === "claimed") reclaimed = result.claim;
    }
    stale.push(await staleSettlement(worker, contested, "earlier_owner"));
    if (reclaimed) stale.push(await staleSettlement(worker, { ...reclaimed, claim_attempt: reclaimed.claim_attempt - 1 }, "older_attempt"));
    if (service) stale.push(await staleSettlement(worker, service, "killed_service"));
    if (reclaimed) {
      const outcome = await settleClaim({ db: worker.db, runners: worker.runners, log: () => undefined }, worker.tenant, reclaimed);
      settlement = outcome.kind === "settled"
        ? { kind: outcome.result.kind, observation_id: outcome.result.kind === "completed" ? outcome.result.observation_id : null,
          detail: outcome.result.kind === "failed" ? outcome.result.terminal_cause : null }
        : { kind: outcome.kind, observation_id: null, detail: outcome.detail };
    }
  }
  return { run_id, run_spend: worker.run_spend, estimate_per_call, before,
    simultaneous: simultaneous.map(({ lease_owner, result }) => claimReadback(lease_owner, result)), after_claims, reclaims, stale, settlement,
    after: await spendNow("second-worker-after") };
}

/** What the second worker's readback must show. */
export function secondWorkerChecks(read: SecondWorkerReadback): readonly ProofCheck[] {
  const claimed = read.simultaneous.filter((claim) => claim.kind === "claimed");
  const deferred = read.simultaneous.filter((claim) => claim.kind === "budget_deferred");
  const touched = read.simultaneous.filter((claim) => claim.kind !== "idle");
  let fits = 0;
  while (fits < touched.length && fitsRunAllowance({ committed: read.before.committed + fits * read.estimate_per_call,
    estimate: read.estimate_per_call, allowance: read.run_spend })) fits++;
  const contested = claimed[0];
  const reclaim = read.reclaims.find((claim) => claim.kind === "claimed");
  const refused = (kind: StaleSettlementReadback["case"]) => {
    const entry = read.stale.find((stale) => stale.case === kind);
    return { passed: entry !== undefined && !entry.mark_request_sent && entry.complete === "stale_claim" && entry.fail === "stale_claim",
      detail: entry ? `${entry.lease_owner}#${entry.claim_attempt} on ${entry.execution_id}: mark ${entry.mark_request_sent}, complete ${entry.complete}, fail ${entry.fail}`
        : "not presented" };
  };
  const earlier = refused("earlier_owner");
  const older = refused("older_attempt");
  const killed = refused("killed_service");
  return [
    check("simultaneous claims at the run allowance's edge: only what fits is claimed and the rest are budget_deferred",
      claimed.length >= 1 && deferred.length >= 1 && claimed.length === fits,
      `${read.simultaneous.length} simultaneous claim(s) on ${touched.length} due execution(s): ${claimed.length} claimed, ${deferred.length} deferred; ${fits} fit beside ${read.before.committed} committed`),
    check("the claims reserve exactly their estimates and never pass the allowance",
      Math.abs(read.after_claims.committed - (read.before.committed + claimed.length * read.estimate_per_call)) < 1e-9
        && read.after_claims.committed <= read.run_spend + 1e-9,
      `committed ${read.before.committed} then ${read.after_claims.committed} of ${read.run_spend}`),
    check("no execution is claimed twice", new Set(touched.map((claim) => claim.execution_id)).size === touched.length,
      touched.map((claim) => claim.execution_id).join(", ")),
    check("an expired claim is reclaimed by another worker as its next claim attempt", contested !== undefined && reclaim !== undefined
      && reclaim.execution_id === contested.execution_id && reclaim.claim_attempt === (contested.claim_attempt ?? 0) + 1,
      read.reclaims.map((claim) => `${claim.kind} ${claim.execution_id ?? ""}#${claim.claim_attempt ?? ""}`).join("; ") || "no reclaim"),
    check("the earlier owner's claim cannot send, complete or fail after the reclaim", earlier.passed, earlier.detail),
    check("the reclaiming owner's older claim attempt is refused the same way", older.passed, older.detail),
    check("the killed service's claim is refused after its lease expired and the execution was reclaimed", killed.passed, killed.detail),
    check("the second worker sends a real request and completes it with an observation", read.settlement?.kind === "completed"
      && read.settlement.observation_id !== null, JSON.stringify(read.settlement)),
    check("each real request is counted once: the expired unsent reservation is released and the reclaim charged once",
      read.after.requests_sent === read.before.requests_sent + 1
        && Math.abs(read.after.committed - (read.before.committed + read.estimate_per_call)) < 1e-9,
      `${read.before.requests_sent} then ${read.after.requests_sent} request(s); committed ${read.before.committed} then ${read.after.committed}`),
  ];
}

/** The shadow's real provider settings, only those the runners graders.json selects can read. */
export async function providerSettings(io: ProofIo): Promise<Readonly<Record<string, string>>> {
  const runners = configuredRunnerNames(JSON.parse(await io.readGraders()));
  if (!runners.ok) throw new Error(runners.error.detail);
  const credentials = credentialsForRunners(runners.value);
  if (!credentials.ok) throw new Error(credentials.error.detail);
  const real = parseEnvFile(await Bun.file(io.state.provider_env_file).text());
  return Object.fromEntries([...credentials.value.required, ...credentials.value.optional]
    .flatMap((setting) => { const value = real.get(setting); return value ? [[setting, value]] : []; }));
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

/** The run's config as the authority committed it, raw; null when it committed none or cannot be read. */
async function authorityConfig(io: ProofIo, run_id: string): Promise<unknown> {
  if (!/^[\w.:/-]+$/.test(run_id)) return null;
  const read = await io.shadowQuery(io.state.postgres.authority_database, `SELECT coalesce(config::text, 'null') FROM authority.run WHERE id = '${run_id}'`);
  if (!read.ok || read.value === "") return null;
  try { return JSON.parse(read.value) as unknown; } catch { return null; }
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
  const concurrency = concurrencyEdit(plans.value.committed);
  const concurrent_plan = graderPlans(JSON.stringify(concurrency));
  if (!concurrent_plan.ok) return { id: "grading", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("the concurrency edit plans a registration", false, concurrent_plan.error.detail)] };
  const committed = plans.value.committed_plan;
  const edited = edited_plan.value.committed_plan;
  const concurrent = concurrent_plan.value.committed_plan;
  const checks: ProofCheck[] = [];
  const runs: RunReference[] = [];
  const measurements: MeasurementReadback[] = [];
  const spend: SpendReadback[] = [];
  const registrations: RegistrationReadback[] = [];
  const pins: PinReadback[] = [];
  const launch_configs: LaunchConfigReadback[] = [];
  /** Each evidence set's references as first served ready; later checkpoints must serve them unchanged. */
  const frozen = new Map<string, { readonly readback: FrozenEvidenceReadback; readonly digest: string }>();
  const changed = new Set<string>();
  let second_worker: SecondWorkerReadback | null = null;
  const directory = await mkdtemp(join(tmpdir(), "oakridge-grading-proof-"));
  const evidence = () => {
    const latest = new Map<string, MeasurementReadback>();
    for (const measurement of measurements) latest.set(`${measurement.evidence_set_id} ${measurement.evaluator_definition_id}`, measurement);
    const final = [...latest.values()];
    return { ...NO_EVIDENCE, runs, registrations, measurements, spend, pins, launch_configs, second_worker,
      frozen_evidence: [...frozen.values()].map((entry) => entry.readback),
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
  const launched = new Map<string, { readonly label: GradingRunLabel; readonly grading_enabled: boolean; readonly checked: boolean }>();
  const runTo = async (label: GradingRunLabel, options: GradingRunOptions): Promise<RunReference | null> => {
    const { report, run } = await source.run(label, options);
    const passed = report.status === "passed" && run !== null;
    checks.push(check(`the ${label} run reaches its ${options.through} on the real stack`, passed,
      report.checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`).join("; ") || run?.run_id || "no run"));
    if (run) { runs.push(run); launched.set(run.run_id, { label, grading_enabled: options.grading_enabled, checked: false }); }
    return passed ? run : null;
  };
  /** Reads a run until `done`, then keeps everything the checkpoint must show: measurements, spend,
   * every pin, frozen references and, the first time the run is read, its launch config. */
  const settle = async (run_id: string, checkpoint: string, done: (read: readonly MeasurementReadback[]) => boolean = settledRun) => {
    const read = await readUntil(io, run_id, checkpoint, done);
    measurements.push(...read);
    const served = await readSpend(io, run_id, checkpoint);
    spend.push(served);
    const pinned = await readRunPins(io, run_id, checkpoint);
    pins.push(...pinned.pins);
    for (const entry of pinned.frozen) {
      const digest = digestOf(entry.references);
      const first = frozen.get(entry.evidence_set_id);
      if (!first) frozen.set(entry.evidence_set_id, { readback: entry, digest });
      else if (first.digest !== digest) changed.add(entry.evidence_set_id);
    }
    checks.push(...pinReadbackChecks(checkpoint, read, pinned.pins, pinned.frozen));
    const run = launched.get(run_id);
    if (run && !run.checked) {
      const authority = await authorityConfig(io, run_id);
      const config: LaunchConfigReadback = { checkpoint, run_id, captured_config: served.captured_config, authority_config: authority };
      launch_configs.push(config);
      checks.push(launchConfigCheck(config, run.grading_enabled, run.label));
      launched.set(run_id, { ...run, checked: true });
    }
    return { read, spend: served };
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
    await io.stopStack();

    // 9. A second worker on the same database: simultaneous claims at one run's allowance, a reclaim,
    // stale claims refused, and a real request settled by the second worker.
    await io.writeGraders(JSON.stringify(concurrency, null, 2) + "\n");
    if (!await startOn("concurrency edit, provider unanswered", concurrent, { provider_env_file: unanswered })) return finish();
    const contested = await runTo("analysis-concurrent", { grading_enabled: true, through: "analysis", capture: "await" });
    if (!contested) return finish();
    const held = await settle(contested.run_id, "concurrent-in-flight", (read) => read.some((measurement) => measurement.detail === "claimed"
      && measurement.attempts.some((attempt) => attempt.request_sent && attempt.outcome === null)));
    checks.push(check("the service holds one claim with its request in flight", held.read.some((measurement) => measurement.detail === "claimed"),
      countBy(held.read)));
    const contestedEvents = await authorityEvents(io, contested.run_id);
    checks.push(await stopObservation("observation is killed with its claim in flight while DBOS keeps serving"));
    const worker = await source.secondWorker();
    checks.push(check("a second worker opens the shadow's observation database", worker.ok, worker.ok ? worker.value.tenant.namespace : worker.error.detail));
    if (!worker.ok) return finish();
    try { second_worker = await secondWorkerPhase(io, worker.value, contested.run_id, CONCURRENT_ESTIMATE_PER_CALL); }
    finally { await worker.value.close(); }
    checks.push(...secondWorkerChecks(second_worker));
    await io.stopStack();
    if (!await startOn("concurrency edit, provider restored", concurrent)) return finish();
    const served = await settle(contested.run_id, "concurrent-after-restart");
    const answer = served.read.find((measurement) => second_worker?.settlement?.observation_id
      && measurement.observation_id === second_worker.settlement.observation_id);
    checks.push(check("the second worker's answer is served with its observation after the restart",
      answer !== undefined && answer.state === "answered", answer ? `${answer.execution_id}: ${JSON.stringify(answer.answer)}` : countBy(served.read)));
    checks.push(check("the restart sends nothing more for the contested run", served.spend.requests_sent === second_worker.after.requests_sent,
      `${second_worker.after.requests_sent} then ${served.spend.requests_sent} request(s); ${JSON.stringify(served.spend.executions)}`));
    checks.push(check("the second worker's grade and the stale writes leave Oakridge authority untouched", contestedEvents !== null
      && await authorityEvents(io, contested.run_id) === contestedEvents, `${contestedEvents} authority event(s) before and after`));
    checks.push(check("frozen evidence is served unchanged at every later checkpoint", frozen.size > 0 && changed.size === 0,
      `${frozen.size} evidence set(s) frozen; ${changed.size} changed${changed.size ? `: ${[...changed].join(", ")}` : ""}`));
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
