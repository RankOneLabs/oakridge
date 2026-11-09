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
import { err, ok, type Result } from "../src/domain/primitives";
import { parseGraderConfiguration, planRegistration, type GraderConfiguration, type GradingRegistration } from "../src/grading/configuration";
import { citationsOf, parseFileCitation } from "../src/producers/oakridge/evidence";
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
  /** The launch input's key for the disposable repository. */
  readonly repository_key: string;
  /** The file at `commit_sha` as the proof reads it itself; null when the commit's tree has no such path. */
  readCited(commit_sha: string, path: string): Promise<Result<string | null, ProofFailure>>;
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

/** The committed graders.json, its edit, and the registration each plans. */
export interface GraderPlans {
  readonly committed: GraderConfiguration;
  readonly edited: GraderConfiguration;
  readonly committed_plan: GradingRegistration;
  readonly edited_plan: GradingRegistration;
}
const planFailure = (entity_id: string, detail: string): ProofFailure => ({ operation: "plan_registration", entity_id, detail });

function planned(configuration: GraderConfiguration, entity_id: string): Result<GradingRegistration, ProofFailure> {
  const registration = planRegistration(configuration, oakridgeProfile.questions);
  return registration.ok ? registration : err(planFailure(entity_id, `${registration.error.kind}: ${registration.error.detail}`));
}
function parsed(text: string): Result<GraderConfiguration, ProofFailure> {
  let json: unknown;
  try { json = JSON.parse(text); } catch (cause) { return err(planFailure("graders.json", cause instanceof Error ? cause.message : String(cause))); }
  const configuration = parseGraderConfiguration(json);
  return configuration.ok ? configuration : err(planFailure("graders.json", configuration.error.detail));
}
/** Parses the committed graders.json, derives the edit and plans both registrations. */
export function graderPlans(text: string): Result<GraderPlans, ProofFailure> {
  const committed = parsed(text);
  if (!committed.ok) return committed;
  const edited = editedGraders(committed.value);
  const committed_plan = planned(committed.value, "committed");
  if (!committed_plan.ok) return committed_plan;
  const edited_plan = planned(edited, "edited");
  if (!edited_plan.ok) return edited_plan;
  return ok({ committed: committed.value, edited, committed_plan: committed_plan.value, edited_plan: edited_plan.value });
}
const definitionIds = (registration: GradingRegistration): readonly string[] =>
  registration.evaluators.map((evaluator) => evaluator.evaluator_definition_id);
const sorted = (values: readonly string[]): readonly string[] => [...values].toSorted();
const same = (left: readonly string[], right: readonly string[]): boolean => JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
const label = (pin: PinReadback): string => `${pin.revision_id}${pin.item_path}:${pin.question_id}`;

interface ServedItem { readonly occurrence_id: string; readonly revision_id: string; readonly json_pointer: string; readonly item_kind: string }
type ServedReference = { readonly ref: string; readonly source: string } & { readonly [field: string]: unknown };
interface ServedEvidence {
  readonly evidence_set_id: string; readonly question_id: string; readonly question_version: string;
  readonly pinned_evaluator_definition_ids: { readonly items: readonly string[] };
  readonly readiness: { readonly state: "ready" | "not_ready"; readonly reason?: { readonly code: string }; readonly ready_at?: string };
  readonly references: { readonly items: readonly ServedReference[] };
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

/** One captured item of a run, whether or not it has pins. */
export interface ItemReadback { readonly occurrence_id: string; readonly revision_id: string; readonly item_path: string; readonly item_kind: string }
/** One read of a run: every item, every pin, and every ready evidence set in full. */
export interface RunReadback {
  readonly items: readonly ItemReadback[];
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
    const read = await io.observationGet(`/v1/items/${encodeURIComponent(item.occurrence_id)}/evidence?limit=200&references_limit=200&pinned_evaluators_limit=200`, "read");
    if (!read.ok) throw new Error(read.error.detail);
    for (const set of (read.value as { readonly items: readonly ServedEvidence[] }).items) {
      const references = set.references.items;
      pins.push({ checkpoint, run_id, occurrence_id: item.occurrence_id, revision_id: item.revision_id, item_path: item.json_pointer,
        item_kind: item.item_kind, question_id: set.question_id, question_version: set.question_version, evidence_set_id: set.evidence_set_id,
        pinned_evaluator_definition_ids: set.pinned_evaluator_definition_ids.items, readiness: set.readiness.state,
        not_ready_code: set.readiness.reason?.code ?? null, ready_at: set.readiness.ready_at ?? null, references: references.map(referenceReadback) });
      if (set.readiness.state === "ready") frozen.push({ checkpoint, run_id, occurrence_id: item.occurrence_id, item_path: item.json_pointer,
        question_id: set.question_id, evidence_set_id: set.evidence_set_id, ready_at: set.readiness.ready_at ?? null, references });
    }
  }
  return { pins, frozen, revision_ids: [...new Set(items.map((item) => item.revision_id))],
    items: items.map((item) => ({ occurrence_id: item.occurrence_id, revision_id: item.revision_id, item_path: item.json_pointer, item_kind: item.item_kind })) };
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
/** The head_sha each captured assessment of a run names, as observation stored it. */
async function assessmentHeads(io: ProofIo, run_id: string): Promise<Result<ReadonlyMap<string, string>, ProofFailure>> {
  if (!/^[\w.:/-]+$/.test(run_id)) return err({ operation: "read_assessment_heads", entity_id: run_id, detail: "unexpected run id" });
  const read = await io.shadowQuery(io.state.observation.database, `SELECT coalesce(json_object_agg(revision_id, body->>'head_sha'), '{}')
    FROM observation.source_revision WHERE run_id = '${run_id}' AND artifact_kind = '${TARGET}'`);
  if (!read.ok) return read;
  const heads = JSON.parse(read.value) as Record<string, string | null>;
  return ok(new Map(Object.entries(heads).flatMap(([revision_id, head]) => head ? [[revision_id, head] as const] : [])));
}
const nothingGraded = (rows: GradingRows | null): boolean => rows !== null && rows.executions === 0 && rows.attempts === 0 && rows.answers === 0;

const questionKey = (pin: { readonly question_id: string; readonly question_version: string }): string => `${pin.question_id}@${pin.question_version}`;

/** Every captured item has exactly the questions its kind applies, each pinned to the configuration's set. */
export function pinChecks(read: RunReadback, registration: GradingRegistration, run: string): readonly ProofCheck[] {
  const problems = read.items.flatMap((item) => {
    const expected = new Map(registration.capture.pins.filter((pin) => pin.item_kind === item.item_kind).map((pin) => [questionKey(pin), pin]));
    const pinned = read.pins.filter((pin) => pin.occurrence_id === item.occurrence_id);
    const place = `${item.revision_id}${item.item_path}`;
    const missing = [...expected.keys()].filter((key) => !pinned.some((pin) => questionKey(pin) === key)).map((key) => `${place}:${key} missing`);
    const wrong = pinned.filter((pin) => {
      const configured = expected.get(questionKey(pin));
      return !configured || !same(configured.evaluator_definition_ids, pin.pinned_evaluator_definition_ids);
    }).map((pin) => `${place}:${questionKey(pin)} ${expected.has(questionKey(pin)) ? "repinned" : "not configured"}`);
    return [...missing, ...wrong];
  });
  return [
    check(`the ${run} run's items are pinned`, read.pins.length > 0, `${read.pins.length} pinned question(s) on ${read.items.length} item(s)`),
    check(`each ${run} item has exactly its questions, pinned to the selection in force at its capture`, read.pins.length > 0 && problems.length === 0,
      problems.length === 0 ? "all match" : problems.join(", ")),
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

/** Evidence sets frozen earlier that a later read no longer serves as ready, or serves with other content or ready time. */
function changedFrozen(required: readonly FrozenEvidenceReadback[], later: readonly FrozenEvidenceReadback[]): readonly string[] {
  const now = new Map(later.map((set) => [set.evidence_set_id, set]));
  return required.flatMap((first) => {
    const set = now.get(first.evidence_set_id);
    const place = `${first.item_path}:${first.question_id}`;
    if (!set) return [`${place} no longer ready`];
    return first.ready_at !== set.ready_at || JSON.stringify(first.references) !== JSON.stringify(set.references) ? [`${place} changed`] : [];
  });
}

/** The first run read again later: identical pins, identical frozen evidence where it was ready. */
export function retainedChecks(before: readonly PinReadback[], after: RunReadback, recorded: ReadonlyMap<string, FrozenEvidenceReadback>,
  checkpoint: string): readonly ProofCheck[] {
  const later = new Map(after.pins.map((pin) => [pin.evidence_set_id, pin]));
  const repinned = before.filter((pin) => !same(pin.pinned_evaluator_definition_ids, later.get(pin.evidence_set_id)?.pinned_evaluator_definition_ids ?? []));
  const own = new Set(before.map((pin) => pin.evidence_set_id));
  const changed = changedFrozen([...recorded.values()].filter((set) => own.has(set.evidence_set_id)), after.frozen);
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

/** One cited file as the proof itself read it from the supplied repository, at the assessment's head_sha. */
export interface CitedFile {
  readonly evidence_set_id: string;
  readonly ref: string;
  readonly repository_key: string;
  readonly commit_sha: string;
  readonly path: string;
  readonly line_range: { readonly start: number; readonly end: number } | null;
  readonly is_absent: boolean;
  readonly content: string | null;
}
const citedLines = (content: string, range: CitedFile["line_range"]): string =>
  range ? content.split("\n").slice(range.start - 1, range.end).join("\n") : content;
/** A frozen set's references, as the service served them. */
const servedReferences = (set: FrozenEvidenceReadback): readonly ServedReference[] => set.references as readonly ServedReference[];
const fileKey = (file: Pick<CitedFile, "evidence_set_id" | "ref">): string => `${file.evidence_set_id} ${file.ref}`;

/** Where the questions that waited should read: each file citation in their subject, at the assessment's head_sha, read independently. */
export async function citedFiles(source: RegistrationSource, heads: ReadonlyMap<string, string>, waited: readonly PinReadback[],
  arrived: readonly FrozenEvidenceReadback[]): Promise<Result<readonly CitedFile[], ProofFailure>> {
  const revisionOf = new Map(waited.map((pin) => [pin.evidence_set_id, pin.revision_id]));
  const files: CitedFile[] = [];
  for (const set of arrived) {
    const revision_id = revisionOf.get(set.evidence_set_id);
    if (revision_id === undefined) continue;
    const commit_sha = heads.get(revision_id);
    if (!commit_sha) return err({ operation: "read_cited_files", entity_id: revision_id, detail: "the captured revision names no head_sha" });
    const subject = servedReferences(set).find((reference) => reference.ref === "subject")?.content;
    for (const [index, citation] of citationsOf((subject ?? null) as Parameters<typeof citationsOf>[0]).entries()) {
      const address = citation.kind === "file" ? parseFileCitation(citation.ref) : null;
      if (!address) continue;
      const read = await source.readCited(commit_sha, address.path);
      if (!read.ok) return read;
      files.push({ evidence_set_id: set.evidence_set_id, ref: `citation:${index}`, repository_key: source.repository_key, commit_sha,
        path: address.path, line_range: address.line_range, is_absent: read.value === null,
        content: read.value === null ? null : citedLines(read.value, address.line_range) });
    }
  }
  return ok(files);
}
/** A served repository reference, reduced to the fields a cited file is compared on. */
const servedFile = (evidence_set_id: string, reference: ServedReference): CitedFile => ({ evidence_set_id,
  ref: reference.ref, repository_key: String(reference.repository_key), commit_sha: String(reference.commit_sha), path: String(reference.path),
  line_range: lineRange(reference.line_range), is_absent: reference.is_absent === true, content: typeof reference.content === "string" ? reference.content : null });

/** The same occurrences, once their input arrived: ready, on their capture-time pins, reading the cited files at the assessed commit. */
export function arrivalChecks(waited: readonly PinReadback[], after: RunReadback, edited: GradingRegistration,
  expected: readonly CitedFile[]): readonly ProofCheck[] {
  const later = new Map(after.pins.map((pin) => [pin.evidence_set_id, pin]));
  const arrived = waited.flatMap((pin) => { const now = later.get(pin.evidence_set_id); return now?.readiness === "ready" ? [{ before: pin, now }] : []; });
  const editedPins = new Map<string, readonly string[]>(edited.capture.pins.map((pin) => [pin.question_id, pin.evaluator_definition_ids]));
  const original = arrived.filter(({ before, now }) => same(before.pinned_evaluator_definition_ids, now.pinned_evaluator_definition_ids)
    && !same(now.pinned_evaluator_definition_ids, editedPins.get(now.question_id) ?? []));
  const arrivedIds = new Set(arrived.map(({ now }) => now.evidence_set_id));
  const served = after.frozen.filter((set) => arrivedIds.has(set.evidence_set_id))
    .flatMap((set) => servedReferences(set).filter((reference) => reference.source === "repository").map((reference) => servedFile(set.evidence_set_id, reference)));
  const servedBy = new Map(served.map((file) => [fileKey(file), file]));
  const expectedBy = new Map(expected.map((file) => [fileKey(file), file]));
  const mismatched = [...new Set([...servedBy.keys(), ...expectedBy.keys()])]
    .filter((key) => JSON.stringify(servedBy.get(key) ?? null) !== JSON.stringify(expectedBy.get(key) ?? null));
  return [
    check("every question waiting at capture is ready once its input is supplied", waited.length > 0 && arrived.length === waited.length,
      `${arrived.length} of ${waited.length} ready`),
    check("they are ready on their capture-time pins, not the edited selection", arrived.length > 0 && original.length === arrived.length,
      `${original.length} of ${arrived.length} on their original pins`),
    check("their evidence reads each cited file at the assessed commit, with the content the repository holds there",
      expected.length > 0 && mismatched.length === 0,
      `${served.length} served, ${expected.length} read by the proof: ${[...new Set(expected.map((file) => `${file.repository_key}@${file.commit_sha}`))].join(", ")}; `
        + `${expected.filter((file) => file.is_absent).length} absent; mismatched: ${mismatched.join(", ") || "none"}`),
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
  const requiredAt = (index: number) => [...recorded.values()].filter((set) => seenAt.get(set.evidence_set_id)! <= index);
  const changed = [...new Set(reads.flatMap((read, index) => changedFrozen(requiredAt(index), read.frozen)))];
  const later_revisions = new Set(overtaken.flatMap(([, index]) => laterThan(index)));
  return [check("evidence frozen earlier in the second run is unchanged by every later revision and task link captured in it",
    overtaken.length > 0 && changed.length === 0,
    `${overtaken.length} set(s) frozen before ${later_revisions.size} later revision(s) across ${reads.length} reads; changed: ${changed.join(", ") || "none"}`)];
}

export async function registrationScenario(io: ProofIo, source: RegistrationSource): Promise<ScenarioReport> {
  if (await io.stackAnswers()) return { id: "registration", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("this proof owns the stack", false, "a shadow is already running; this proof restarts it with an edited graders.json")] };
  const original = await io.readGraders();
  const plans = graderPlans(original);
  if (!plans.ok) return { id: "registration", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("graders.json and its edit plan a registration", false, `${plans.error.entity_id}: ${plans.error.detail}`)] };
  const { edited, committed_plan, edited_plan } = plans.value;
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
  const startOn = async (checkpoint: string, registration: GradingRegistration): Promise<boolean> => {
    const started = await io.startStack();
    checks.push(check(`the stack starts (${checkpoint})`, started.ok, started.ok ? "answered" : started.error.detail));
    if (!started.ok) return false;
    const settled = await settleObservation(io);
    checks.push(check(`observation is reachable (${checkpoint})`, observationSettled(settled.health), `health ${settled.health}; launcher ${settled.launcher}`));
    const registered = await registrationReadback(io, checkpoint);
    registrations.push(registered);
    const expected = registration.graders.map((grader) => grader.evaluator_definition_id);
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
    if (!await startOn("committed", committed_plan)) return finish();
    const first = await source.run("first", { capture: "deferred", after_launch: stopObservation });
    await io.stopStack();
    if (!ran("first", first.report, first.run)) return finish();
    const first_run = first.run!;

    const withheld = await source.withholdRepository();
    checks.push(check("the first run's launch repository is withheld from observation", withheld.ok, withheld.ok ? withheld.value : withheld.error.detail));
    if (!withheld.ok || !await startOn("committed, repository withheld", committed_plan)) return finish();
    checks.push(...runCaptureChecks(await awaitRunCapture(io, { run_id: first_run.run_id, target_artifact: TARGET })));
    const atCapture = record(await readUntil(io, first_run.run_id, "first-capture"));
    checks.push(...pinChecks(atCapture, committed_plan, "first"), ...waitingAtCaptureChecks(atCapture.pins));
    const waited = atCapture.pins.filter(isWaiting);
    rows = await gradingRows(io);
    checks.push(check("capture and collection execute nothing", nothingGraded(rows), JSON.stringify(rows)));
    await io.stopStack();

    await io.writeGraders(JSON.stringify(edited, null, 2) + "\n");
    if (!await startOn("edited, repository withheld", edited_plan)) return finish();
    const committedIds = definitionIds(committed_plan);
    const editedIds = definitionIds(edited_plan);
    const stored = registrations.at(-1)?.stored_evaluator_definition_ids ?? [];
    checks.push(check("the edit registered new definitions and kept every earlier one",
      [...committedIds, ...editedIds].every((id) => stored.includes(id)) && editedIds.some((id) => !committedIds.includes(id)),
      `${stored.length} stored; ${editedIds.filter((id) => !committedIds.includes(id)).length} new`));
    const afterSwap = record(await readUntil(io, first_run.run_id, "first-after-swap"));
    checks.push(...retainedChecks(atCapture.pins, afterSwap, frozen, "after the swap"), stillWaitingCheck(waited, afterSwap));
    await io.stopStack();

    const supplied = await source.supplyRepository();
    checks.push(check("the withheld repository is supplied", supplied.ok, supplied.ok ? supplied.value : supplied.error.detail));
    if (!supplied.ok || !await startOn("edited, repository supplied", edited_plan)) return finish();
    const waitedIds = new Set(waited.map((pin) => pin.evidence_set_id));
    const arrival = record(await readUntil(io, first_run.run_id, "first-after-arrival",
      (read) => read.pins.every((pin) => !waitedIds.has(pin.evidence_set_id) || pin.readiness === "ready")));
    const heads = await assessmentHeads(io, first_run.run_id);
    const expected = heads.ok ? await citedFiles(source, heads.value, waited, arrival.frozen) : heads;
    if (!expected.ok) checks.push(check("the proof reads each cited file itself", false, `${expected.error.operation}: ${expected.error.detail}`));
    checks.push(...arrivalChecks(waited, arrival, edited_plan, expected.ok ? expected.value : []),
      ...retainedChecks(atCapture.pins, arrival, frozen, "after its input arrived"));

    let watch: RunWatch | null = null;
    const second = await source.run("second", { capture: "await", after_launch: async (run) => {
      watch = watchRun(io, run.run_id, "second-progress");
      return check("the second run launches with observation up", true, run.run_id);
    } });
    const snapshots = await (watch as RunWatch | null)?.stop() ?? [];
    for (const snapshot of snapshots) for (const set of snapshot.frozen) if (!frozen.has(set.evidence_set_id)) frozen.set(set.evidence_set_id, set);
    if (ran("second", second.report, second.run)) {
      const final = record(await readUntil(io, second.run!.run_id, "second"));
      checks.push(...pinChecks(final, edited_plan, "second"), ...laterRevisionChecks(snapshots, final));
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
