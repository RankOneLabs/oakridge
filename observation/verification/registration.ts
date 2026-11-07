/**
 * Startup registration, capture pins and per-question evidence on the real shadow, across a
 * graders.json edit and restart, with a required lookup forced to wait on a real capture:
 *
 *   start on the committed selection -> launch a real run and stop observation while it runs to
 *   its assessment -> withhold the launch repository holding the assessed commit and restart, so
 *   observation captures the run and its file-citing questions wait -> edit graders.json and
 *   restart: the edit registers new definitions, the first run keeps its pins and still waits ->
 *   supply the repository and restart: the same questions become ready on their original pins,
 *   reading each cited file at the assessed commit -> capture a second real run with observation
 *   up, which takes the edited selection, while evidence frozen earlier in it stays unchanged by
 *   every later revision and link -> nothing executed, called a provider or answered throughout.
 *
 * Both runs are real development runs launched through source-run on the same stack. The
 * committed graders.json and the withheld repository are restored whatever happens. This
 * scenario sends no provider request; automatic-execution-lifecycle continues it with real
 * executions.
 */
import type { Result } from "../src/domain/primitives";
import { parseGraderConfiguration, planRegistration, type GraderConfiguration, type GradingRegistration } from "../src/grading/configuration";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { NO_EVIDENCE, scenarioStatus, type FrozenEvidenceReadback, type PinReadback, type ProofCheck, type ProofFailure, type ReferenceReadback,
  type RegistrationReadback, type RunReference, type ScenarioReport } from "./proof-contract";
import { awaitRunCapture, runCaptureChecks } from "./run-capture";
import { observationSettled, settleObservation } from "./scenarios";
import type { ProofIo } from "./shadow-session";

const COLLECTION_ATTEMPTS = 240;
const POLL_MS = 500;
const WATCH_MS = 10_000;
const WATCH_LIMIT = 720;
const PAGE = 200;
const TARGET = "assessment";
const COLLECTION_PENDING = "collection_pending";

const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });

export type RunLabel = "first" | "second";
export interface RegistrationRunOptions {
  /** Runs once the run has launched, before it is driven. */
  readonly after_launch: (run: RunReference) => Promise<ProofCheck>;
  /** `deferred` leaves the capture to the scenario, which keeps observation down meanwhile. */
  readonly capture: "await" | "deferred";
}
/** The real runs and the one launch repository the scenario may withhold from observation. */
export interface RegistrationSource {
  run(label: RunLabel, options: RegistrationRunOptions): Promise<{ readonly report: ScenarioReport; readonly run: RunReference | null }>;
  /** Makes the disposable launch repository unreadable at its launch path; never the live checkout. */
  withholdRepository(): Promise<Result<string, ProofFailure>>;
  /** Puts it back. Safe to call when it is not withheld. */
  supplyRepository(): Promise<Result<string, ProofFailure>>;
}

/** The edit an operator makes to swap graders: new instructions for every configured grader.
 * Only graders.json changes; the runner and model stay real so a later cohort can execute them. */
export function editedGraders(configuration: GraderConfiguration): GraderConfiguration {
  return { questions: configuration.questions.map((entry) => ({ ...entry, graders: entry.graders.map((grader) => {
    const recipe = grader.instructions as { readonly system_one?: { readonly instructions?: unknown } } | null;
    const text = recipe?.system_one?.instructions;
    return typeof text === "string" && recipe?.system_one
      ? { ...grader, instructions: { ...recipe, system_one: { ...recipe.system_one, instructions: `${text} Use only the evidence given.` } } }
      : { ...grader, estimated_cost_per_call: grader.estimated_cost_per_call + 0.001 };
  }) })) };
}

function planned(configuration: GraderConfiguration): GradingRegistration {
  const registration = planRegistration(configuration, oakridgeProfile.questions);
  if (!registration.ok) throw new Error(`${registration.error.kind}: ${registration.error.detail}`);
  return registration.value;
}
function parsed(text: string): GraderConfiguration {
  const configuration = parseGraderConfiguration(JSON.parse(text));
  if (!configuration.ok) throw new Error(configuration.error.detail);
  return configuration.value;
}
const sorted = (values: readonly string[]): readonly string[] => [...values].toSorted();
const same = (left: readonly string[], right: readonly string[]): boolean => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const label = (pin: PinReadback): string => `${pin.revision_id}${pin.item_path}:${pin.question_id}`;

interface ServedItem { readonly occurrence_id: string; readonly revision_id: string; readonly json_pointer: string; readonly item_kind: string }
type ServedReference = { readonly ref: string; readonly source: string } & { readonly [field: string]: unknown };
interface ServedEvidence {
  readonly evidence_set_id: string; readonly question_id: string; readonly question_version: string;
  readonly pinned_evaluator_definition_ids: readonly string[];
  readonly readiness: { readonly state: "ready" | "not_ready"; readonly reason?: { readonly code: string };
    readonly references?: readonly ServedReference[]; readonly ready_at?: string };
}

const text = (value: unknown): string | null => typeof value === "string" ? value : null;
const lineRange = (value: unknown): ReferenceReadback["line_range"] => {
  const range = value as { readonly start?: unknown; readonly end?: unknown } | null;
  return typeof range?.start === "number" && typeof range.end === "number" ? { start: range.start, end: range.end } : null;
};
export const referenceReadback = (reference: ServedReference): ReferenceReadback => ({ ref: reference.ref, source: reference.source,
  revision_id: text(reference.revision_id), item_path: text(reference.item_path), run_id: text(reference.run_id),
  input_path: text(reference.input_path), repository_key: text(reference.repository_key), commit_sha: text(reference.commit_sha),
  path: text(reference.path), line_range: lineRange(reference.line_range),
  is_absent: typeof reference.is_absent === "boolean" ? reference.is_absent : null, reported_by: text(reference.reported_by) });

/** One read of a run: every pin, and every ready evidence set in full. */
export interface RunReadback {
  readonly pins: readonly PinReadback[];
  readonly frozen: readonly FrozenEvidenceReadback[];
  readonly revision_ids: readonly string[];
}

/** Every pin of a run's items, read through the read capability. */
export async function readRunPins(io: ProofIo, run_id: string, checkpoint: string): Promise<RunReadback> {
  const items: ServedItem[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await io.observationGet(`/v1/runs/${encodeURIComponent(run_id)}/items?limit=${PAGE}&offset=${offset}`, "read");
    if (!page.ok) throw new Error(page.error.detail);
    const served = (page.value as { readonly items: readonly ServedItem[] }).items;
    items.push(...served);
    if (served.length < PAGE) break;
  }
  const pins: PinReadback[] = [];
  const frozen: FrozenEvidenceReadback[] = [];
  for (const item of items) {
    const read = await io.observationGet(`/v1/items/${encodeURIComponent(item.occurrence_id)}/evidence`, "read");
    if (!read.ok) throw new Error(read.error.detail);
    for (const set of (read.value as { readonly items: readonly ServedEvidence[] }).items) {
      const references = set.readiness.references ?? [];
      pins.push({ checkpoint, run_id, occurrence_id: item.occurrence_id, revision_id: item.revision_id, item_path: item.json_pointer,
        item_kind: item.item_kind, question_id: set.question_id, question_version: set.question_version, evidence_set_id: set.evidence_set_id,
        pinned_evaluator_definition_ids: set.pinned_evaluator_definition_ids, readiness: set.readiness.state,
        not_ready_code: set.readiness.reason?.code ?? null, ready_at: set.readiness.ready_at ?? null, references: references.map(referenceReadback) });
      if (set.readiness.state === "ready") frozen.push({ checkpoint, run_id, occurrence_id: item.occurrence_id, item_path: item.json_pointer,
        question_id: set.question_id, evidence_set_id: set.evidence_set_id, ready_at: set.readiness.ready_at ?? null, references });
    }
  }
  return { pins, frozen, revision_ids: [...new Set(items.map((item) => item.revision_id))] };
}

/** Reads until `done` holds, or the attempts run out; a question still `collection_pending` has not been looked at. */
async function readUntil(io: ProofIo, run_id: string, checkpoint: string, done: (read: RunReadback) => boolean = () => true): Promise<RunReadback> {
  let read = await readRunPins(io, run_id, checkpoint);
  const settled = (value: RunReadback) => !value.pins.some((pin) => pin.not_ready_code === COLLECTION_PENDING) && done(value);
  for (let attempt = 0; attempt < COLLECTION_ATTEMPTS && !settled(read); attempt++) {
    await io.sleep(POLL_MS);
    read = await readRunPins(io, run_id, checkpoint);
  }
  return read;
}

async function registrationReadback(io: ProofIo, checkpoint: string): Promise<RegistrationReadback> {
  const health = await io.kbblHealth();
  const graders = health?.observation.state === "configured"
    ? health.observation.graders.map((grader) => ({ runner: grader.runner, evaluator_definition_id: grader.evaluatorDefinitionId })) : [];
  const stored = await io.shadowQuery(io.state.observation.database,
    "SELECT coalesce(json_agg(evaluator_definition_id ORDER BY evaluator_definition_id), '[]') FROM observation.evaluator_definition");
  return { checkpoint, graders, stored_evaluator_definition_ids: stored.ok ? JSON.parse(stored.value) as string[] : [] };
}

interface GradingRows { readonly executions: number; readonly attempts: number; readonly requests_sent: number; readonly answers: number }
async function gradingRows(io: ProofIo): Promise<GradingRows | null> {
  const counted = await io.shadowQuery(io.state.observation.database, `SELECT json_build_object(
    'executions', (SELECT count(*) FROM observation.evaluation_execution),
    'attempts', (SELECT count(*) FROM observation.grading_provider_attempt),
    'requests_sent', (SELECT count(*) FROM observation.grading_provider_attempt WHERE request_sent),
    'answers', (SELECT count(*) FROM observation.grade_observation))`);
  return counted.ok ? JSON.parse(counted.value) as GradingRows : null;
}
const nothingGraded = (rows: GradingRows | null): boolean => rows !== null && rows.executions === 0 && rows.attempts === 0 && rows.answers === 0;

/** Every applicable question is pinned, and each pin is exactly the configuration's set. */
export function pinChecks(pins: readonly PinReadback[], registration: GradingRegistration, run: string): readonly ProofCheck[] {
  const expected = new Map(registration.capture.pins.map((pin) => [`${pin.question_id}@${pin.question_version}`, pin]));
  const wrong = pins.filter((pin) => {
    const configured = expected.get(`${pin.question_id}@${pin.question_version}`);
    return !configured || configured.item_kind !== pin.item_kind || !same(configured.evaluator_definition_ids, pin.pinned_evaluator_definition_ids);
  });
  return [
    check(`the ${run} run's items are pinned`, pins.length > 0, `${pins.length} pinned question(s)`),
    check(`each ${run} pin is exactly the selection in force at its capture`, pins.length > 0 && wrong.length === 0,
      wrong.length === 0 ? "all match" : wrong.map(label).join(", ")),
  ];
}

/** A wait on a required lookup, not collection that has yet to run. */
const isWaiting = (pin: PinReadback): boolean => pin.readiness === "not_ready" && pin.not_ready_code !== COLLECTION_PENDING;

/** What capture showed: some questions wait on a required lookup while the rest are ready. */
export function waitingAtCaptureChecks(pins: readonly PinReadback[]): readonly ProofCheck[] {
  const waiting = pins.filter(isWaiting);
  const ready = pins.filter((pin) => pin.readiness === "ready");
  const codes = [...new Set(waiting.map((pin) => pin.not_ready_code))].join(",");
  const occurrences = (question: string, matches: (pin: PinReadback) => boolean) => new Set(pins
    .filter((pin) => pin.question_id.endsWith(question) && matches(pin)).map((pin) => pin.occurrence_id));
  const correctnessWaiting = occurrences("correctness", isWaiting);
  const split = [...occurrences("evidence_support", (pin) => pin.readiness === "ready")].filter((occurrence) => correctnessWaiting.has(occurrence)).length;
  return [
    check("a required lookup is waiting at capture", waiting.length > 0, `${waiting.length} waiting (${codes || "none"})`),
    check("a waiting question delays no other question", waiting.length > 0 && ready.length > 0,
      `${ready.length} ready beside ${waiting.length} waiting; ${split} finding(s) with Correctness waiting and Evidence support ready`),
  ];
}

/** Frozen evidence sets whose content or ready time differ from what was first read. */
function changedFrozen(recorded: ReadonlyMap<string, FrozenEvidenceReadback>, later: readonly FrozenEvidenceReadback[]): readonly string[] {
  return later.filter((set) => {
    const first = recorded.get(set.evidence_set_id);
    return first !== undefined && (first.ready_at !== set.ready_at || JSON.stringify(first.references) !== JSON.stringify(set.references));
  }).map((set) => `${set.item_path}:${set.question_id}`);
}

/** The first run read again later: identical pins, identical frozen evidence where it was ready. */
export function retainedChecks(before: readonly PinReadback[], after: RunReadback, recorded: ReadonlyMap<string, FrozenEvidenceReadback>,
  checkpoint: string): readonly ProofCheck[] {
  const later = new Map(after.pins.map((pin) => [pin.evidence_set_id, pin]));
  const repinned = before.filter((pin) => !same(pin.pinned_evaluator_definition_ids, later.get(pin.evidence_set_id)?.pinned_evaluator_definition_ids ?? []));
  const changed = changedFrozen(recorded, after.frozen);
  return [check(`the first run keeps every pin and frozen evidence set ${checkpoint}`,
    before.length > 0 && after.pins.length === before.length && repinned.length === 0 && changed.length === 0,
    `${after.pins.length} of ${before.length} pins read; repinned: ${repinned.map(label).join(", ") || "none"}; changed evidence: ${changed.join(", ") || "none"}`)];
}

/** Questions that waited at capture, read while their input is still withheld. */
export function stillWaitingCheck(waited: readonly PinReadback[], after: RunReadback): ProofCheck {
  const later = new Map(after.pins.map((pin) => [pin.evidence_set_id, pin]));
  const moved = waited.filter((pin) => later.get(pin.evidence_set_id)?.not_ready_code !== pin.not_ready_code);
  return check("questions waiting on a withheld input still wait through the swap and restart", waited.length > 0 && moved.length === 0,
    moved.length === 0 ? `${waited.length} still waiting` : moved.map(label).join(", "));
}

/** The same occurrences, once their input arrived: ready, on their capture-time pins, reading the cited files at the assessed commit. */
export function arrivalChecks(waited: readonly PinReadback[], after: RunReadback, edited: GradingRegistration): readonly ProofCheck[] {
  const later = new Map(after.pins.map((pin) => [pin.evidence_set_id, pin]));
  const arrived = waited.flatMap((pin) => { const now = later.get(pin.evidence_set_id); return now?.readiness === "ready" ? [{ before: pin, now }] : []; });
  const editedPins = new Map<string, readonly string[]>(edited.capture.pins.map((pin) => [pin.question_id, pin.evaluator_definition_ids]));
  const original = arrived.filter(({ before, now }) => same(before.pinned_evaluator_definition_ids, now.pinned_evaluator_definition_ids)
    && !same(now.pinned_evaluator_definition_ids, editedPins.get(now.question_id) ?? []));
  const files = arrived.flatMap(({ now }) => now.references.filter((reference) => reference.source === "repository"));
  const located = files.filter((reference) => reference.repository_key && reference.commit_sha && reference.path && reference.is_absent !== null);
  return [
    check("every question waiting at capture is ready once its input is supplied", waited.length > 0 && arrived.length === waited.length,
      `${arrived.length} of ${waited.length} ready`),
    check("they are ready on their capture-time pins, not the edited selection", arrived.length > 0 && original.length === arrived.length,
      `${original.length} of ${arrived.length} on their original pins`),
    check("their evidence reads each cited file at the assessed commit in a launch repository", files.length > 0 && located.length === files.length,
      `${files.length} file reference(s): ${[...new Set(located.map((reference) => `${reference.repository_key}@${reference.commit_sha}`))].join(", ")}; `
        + `${files.filter((reference) => reference.is_absent).length} absent`),
  ];
}

/** Snapshots of a run while it progresses. */
export interface RunWatch { stop(): Promise<readonly RunReadback[]> }
function watchRun(io: ProofIo, run_id: string, checkpoint: string): RunWatch {
  let stopped = false;
  const snapshots: RunReadback[] = [];
  const loop = (async () => {
    for (let polls = 0; !stopped && polls < WATCH_LIMIT; polls++) {
      try { snapshots.push(await readRunPins(io, run_id, checkpoint)); } catch { /* the service may be catching up; the next poll reads again */ }
      await io.sleep(WATCH_MS);
    }
  })();
  return { async stop() { stopped = true; await loop; return snapshots; } };
}

/** Evidence frozen at one snapshot, compared with every later snapshot and the final read, after later revisions arrived. */
export function laterRevisionChecks(snapshots: readonly RunReadback[], final: RunReadback): readonly ProofCheck[] {
  const reads = [...snapshots, final];
  const recorded = new Map<string, FrozenEvidenceReadback>();
  const seenAt = new Map<string, number>();
  for (const [index, read] of reads.entries()) for (const set of read.frozen) if (!recorded.has(set.evidence_set_id)) {
    recorded.set(set.evidence_set_id, set);
    seenAt.set(set.evidence_set_id, index);
  }
  const laterThan = (index: number) => final.revision_ids.filter((revision) => !reads[index]!.revision_ids.includes(revision));
  // Sets frozen before at least one revision the run published afterwards.
  const overtaken = [...seenAt].filter(([, index]) => laterThan(index).length > 0);
  const changed = [...new Set(reads.flatMap((read) => changedFrozen(recorded, read.frozen)))];
  const later_revisions = new Set(overtaken.flatMap(([, index]) => laterThan(index)));
  return [check("evidence frozen earlier in the second run is unchanged by every later revision and task link captured in it",
    overtaken.length > 0 && changed.length === 0,
    `${overtaken.length} set(s) frozen before ${later_revisions.size} later revision(s) across ${reads.length} reads; changed: ${changed.join(", ") || "none"}`)];
}

export async function registrationScenario(io: ProofIo, source: RegistrationSource): Promise<ScenarioReport> {
  if (await io.stackAnswers()) return { id: "registration", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("this proof owns the stack", false, "a shadow is already running; this proof restarts it with an edited graders.json")] };
  const original = await io.readGraders();
  const committed = parsed(original);
  const edited = editedGraders(committed);
  const checks: ProofCheck[] = [];
  const registrations: RegistrationReadback[] = [];
  const pins: PinReadback[] = [];
  const frozen = new Map<string, FrozenEvidenceReadback>();
  const runs: RunReference[] = [];
  let rows: GradingRows | null = null;
  const evidence = () => ({ ...NO_EVIDENCE, runs, registrations, pins, frozen_evidence: [...frozen.values()],
    pinned_definitions: [...new Set(pins.flatMap((pin) => pin.pinned_evaluator_definition_ids))],
    source_revisions: [...new Set(pins.map((pin) => pin.revision_id))], item_paths: [...new Set(pins.map((pin) => `${pin.revision_id}${pin.item_path}`))],
    provider_request_count: rows?.requests_sent ?? null });
  const finish = (): ScenarioReport => ({ id: "registration", status: scenarioStatus(checks), checks, evidence: evidence() });
  const record = (read: RunReadback): RunReadback => {
    pins.push(...read.pins);
    for (const set of read.frozen) if (!frozen.has(set.evidence_set_id)) frozen.set(set.evidence_set_id, set);
    return read;
  };
  const startOn = async (checkpoint: string, configuration: GraderConfiguration): Promise<boolean> => {
    const started = await io.startStack();
    checks.push(check(`the stack starts (${checkpoint})`, started.ok, started.ok ? "answered" : started.error.detail));
    if (!started.ok) return false;
    const settled = await settleObservation(io);
    checks.push(check(`observation is reachable (${checkpoint})`, observationSettled(settled.health), `health ${settled.health}; launcher ${settled.launcher}`));
    const registered = await registrationReadback(io, checkpoint);
    registrations.push(registered);
    const expected = planned(configuration).graders.map((grader) => grader.evaluator_definition_id);
    checks.push(check(`startup registered the configured graders (${checkpoint})`, same(registered.graders.map((grader) => grader.evaluator_definition_id), expected),
      registered.graders.map((grader) => `${grader.runner}:${grader.evaluator_definition_id}`).join(", ") || `health ${settled.health}`));
    return observationSettled(settled.health);
  };
  const stopObservation = async (): Promise<ProofCheck> => {
    const status = await io.observationStatus();
    const pid = Number(/^pid_(\d+)$/.exec(status?.detail ?? "")?.[1]);
    if (!pid) return check("observation is down while the first run progresses", false, `no running service recorded: ${JSON.stringify(status)}`);
    io.killObservation(pid);
    let health = await io.kbblHealth();
    for (let attempt = 0; attempt < COLLECTION_ATTEMPTS && health?.observation.state !== "down"; attempt++) {
      await io.sleep(POLL_MS);
      health = await io.kbblHealth();
    }
    return check("observation is down while the first run progresses", health?.observation.state === "down", JSON.stringify(health?.observation ?? null));
  };
  const ran = (run: RunLabel, report: ScenarioReport, reference: RunReference | null): reference is RunReference => {
    checks.push(check(`the ${run} run reaches its ${TARGET} on the real stack`, report.status === "passed" && reference !== null,
      report.checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`).join("; ") || reference?.run_id || "no run"));
    if (reference) runs.push(reference);
    return report.status === "passed" && reference !== null;
  };
  try {
    if (!await startOn("committed", committed)) return finish();
    const first = await source.run("first", { capture: "deferred", after_launch: stopObservation });
    await io.stopStack();
    if (!ran("first", first.report, first.run)) return finish();
    const first_run = first.run!;

    const withheld = await source.withholdRepository();
    checks.push(check("the first run's launch repository is withheld from observation", withheld.ok, withheld.ok ? withheld.value : withheld.error.detail));
    if (!withheld.ok || !await startOn("committed, repository withheld", committed)) return finish();
    checks.push(...runCaptureChecks(await awaitRunCapture(io, { run_id: first_run.run_id, target_artifact: TARGET })));
    const atCapture = record(await readUntil(io, first_run.run_id, "first-capture"));
    checks.push(...pinChecks(atCapture.pins, planned(committed), "first"), ...waitingAtCaptureChecks(atCapture.pins));
    const waited = atCapture.pins.filter(isWaiting);
    rows = await gradingRows(io);
    checks.push(check("capture and collection execute nothing", nothingGraded(rows), JSON.stringify(rows)));
    await io.stopStack();

    await io.writeGraders(JSON.stringify(edited, null, 2) + "\n");
    if (!await startOn("edited, repository withheld", edited)) return finish();
    const committedIds = planned(committed).evaluators.map((evaluator) => evaluator.evaluator_definition_id);
    const editedIds = planned(edited).evaluators.map((evaluator) => evaluator.evaluator_definition_id);
    const stored = registrations.at(-1)?.stored_evaluator_definition_ids ?? [];
    checks.push(check("the edit registered new definitions and kept every earlier one",
      [...committedIds, ...editedIds].every((id) => stored.includes(id)) && editedIds.some((id) => !committedIds.includes(id)),
      `${stored.length} stored; ${editedIds.filter((id) => !committedIds.includes(id)).length} new`));
    const afterSwap = record(await readUntil(io, first_run.run_id, "first-after-swap"));
    checks.push(...retainedChecks(atCapture.pins, afterSwap, frozen, "after the swap"), stillWaitingCheck(waited, afterSwap));
    await io.stopStack();

    const supplied = await source.supplyRepository();
    checks.push(check("the withheld repository is supplied", supplied.ok, supplied.ok ? supplied.value : supplied.error.detail));
    if (!supplied.ok || !await startOn("edited, repository supplied", edited)) return finish();
    const waitedIds = new Set(waited.map((pin) => pin.evidence_set_id));
    const arrival = record(await readUntil(io, first_run.run_id, "first-after-arrival",
      (read) => read.pins.every((pin) => !waitedIds.has(pin.evidence_set_id) || pin.readiness === "ready")));
    checks.push(...arrivalChecks(waited, arrival, planned(edited)), ...retainedChecks(atCapture.pins, arrival, frozen, "after its input arrived"));

    let watch: RunWatch | null = null;
    const second = await source.run("second", { capture: "await", after_launch: async (run) => {
      watch = watchRun(io, run.run_id, "second-progress");
      return check("the second run launches with observation up", true, run.run_id);
    } });
    const snapshots = await (watch as RunWatch | null)?.stop() ?? [];
    for (const snapshot of snapshots) for (const set of snapshot.frozen) if (!frozen.has(set.evidence_set_id)) frozen.set(set.evidence_set_id, set);
    if (ran("second", second.report, second.run)) {
      const final = record(await readUntil(io, second.run!.run_id, "second"));
      checks.push(...pinChecks(final.pins, planned(edited), "second"), ...laterRevisionChecks(snapshots, final));
    }
    rows = await gradingRows(io);
    checks.push(check("evidence is collected with automatic grading off, and nothing is executed, sent or answered",
      frozen.size > 0 && nothingGraded(rows), `${frozen.size} frozen evidence set(s); ${JSON.stringify(rows)}`));
    return finish();
  } finally {
    await io.stopStack();
    await io.writeGraders(original);
    await source.supplyRepository();
  }
}
