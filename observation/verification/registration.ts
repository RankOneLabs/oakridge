/**
 * Startup registration, capture pins and evidence collection on the real shadow, across a
 * graders.json edit and restart:
 *
 *   start on the committed selection -> capture a real run -> read back its pins and readiness
 *   -> edit graders.json and restart -> the first run keeps its pins and frozen evidence, the
 *   edited graders are new definitions and the old ones remain -> capture a second real run,
 *   which takes the edited selection -> nothing executed, called a provider or answered.
 *
 * Both captures come from real development runs launched through source-run on the same stack.
 * The committed graders.json is restored whatever happens. This scenario sends no provider
 * request; the automatic-execution-lifecycle cohort continues it with real executions.
 */
import { parseGraderConfiguration, planRegistration, type GraderConfiguration, type GradingRegistration } from "../src/grading/configuration";
import { oakridgeProfile } from "../src/producers/oakridge/profile";
import { NO_EVIDENCE, scenarioStatus, type PinReadback, type ProofCheck, type ReferenceReadback, type RegistrationReadback,
  type RunReference, type ScenarioReport } from "./proof-contract";
import { observationSettled, settleObservation } from "./scenarios";
import type { ProofIo } from "./shadow-session";

const COLLECTION_ATTEMPTS = 240;
const POLL_MS = 500;
const PAGE = 200;

const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });

/** A real capture on the running stack: one launched run and the report of its capture. */
export type RegistrationCapture = (label: "first" | "second") => Promise<{ readonly report: ScenarioReport; readonly run: RunReference | null }>;

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

interface ServedItem { readonly occurrence_id: string; readonly revision_id: string; readonly json_pointer: string; readonly item_kind: string }
interface ServedReference { readonly ref: string; readonly source: string; readonly revision_id?: string; readonly item_path?: string | null;
  readonly commit_sha?: string; readonly path?: string }
interface ServedEvidence {
  readonly evidence_set_id: string; readonly question_id: string; readonly question_version: string;
  readonly pinned_evaluator_definition_ids: readonly string[];
  readonly readiness: { readonly state: "ready" | "not_ready"; readonly reason?: { readonly code: string };
    readonly references?: readonly ServedReference[]; readonly ready_at?: string };
}

const referenceReadback = (reference: ServedReference): ReferenceReadback => ({ ref: reference.ref, source: reference.source,
  revision_id: reference.revision_id ?? null, item_path: reference.item_path ?? null, commit_sha: reference.commit_sha ?? null, path: reference.path ?? null });

/** Every pin of a run's items, read through the read capability. */
export async function readRunPins(io: ProofIo, run_id: string, checkpoint: string): Promise<readonly PinReadback[]> {
  const items: ServedItem[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await io.observationGet(`/v1/runs/${encodeURIComponent(run_id)}/items?limit=${PAGE}&offset=${offset}`, "read");
    if (!page.ok) throw new Error(page.error.detail);
    const served = (page.value as { readonly items: readonly ServedItem[] }).items;
    items.push(...served);
    if (served.length < PAGE) break;
  }
  const pins: PinReadback[] = [];
  for (const item of items) {
    const read = await io.observationGet(`/v1/items/${encodeURIComponent(item.occurrence_id)}/evidence`, "read");
    if (!read.ok) throw new Error(read.error.detail);
    for (const set of (read.value as { readonly items: readonly ServedEvidence[] }).items) pins.push({ checkpoint, run_id,
      occurrence_id: item.occurrence_id, revision_id: item.revision_id, item_path: item.json_pointer, item_kind: item.item_kind,
      question_id: set.question_id, question_version: set.question_version, evidence_set_id: set.evidence_set_id,
      pinned_evaluator_definition_ids: set.pinned_evaluator_definition_ids, readiness: set.readiness.state,
      not_ready_code: set.readiness.reason?.code ?? null, ready_at: set.readiness.ready_at ?? null,
      references: (set.readiness.references ?? []).map(referenceReadback) });
  }
  return pins;
}

/** Pins once collection has run: a question still `collection_pending` has not been looked at yet. */
async function settledPins(io: ProofIo, run_id: string, checkpoint: string): Promise<readonly PinReadback[]> {
  let pins = await readRunPins(io, run_id, checkpoint);
  for (let attempt = 0; attempt < COLLECTION_ATTEMPTS && pins.some((pin) => pin.not_ready_code === "collection_pending"); attempt++) {
    await io.sleep(POLL_MS);
    pins = await readRunPins(io, run_id, checkpoint);
  }
  return pins;
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
export function pinChecks(pins: readonly PinReadback[], registration: GradingRegistration, label: string): readonly ProofCheck[] {
  const expected = new Map(registration.capture.pins.map((pin) => [`${pin.question_id}@${pin.question_version}`, pin]));
  const wrong = pins.filter((pin) => {
    const configured = expected.get(`${pin.question_id}@${pin.question_version}`);
    return !configured || configured.item_kind !== pin.item_kind || !same(configured.evaluator_definition_ids, pin.pinned_evaluator_definition_ids);
  });
  return [
    check(`the ${label} run's items are pinned`, pins.length > 0, `${pins.length} pinned question(s)`),
    check(`each ${label} pin is exactly the selection in force at its capture`, pins.length > 0 && wrong.length === 0,
      wrong.length === 0 ? "all match" : wrong.map((pin) => `${pin.item_path}:${pin.question_id}`).join(", ")),
  ];
}

/** The first run read again after the swap: identical pins, and identical frozen evidence where it was ready. */
export function retainedChecks(before: readonly PinReadback[], after: readonly PinReadback[]): readonly ProofCheck[] {
  const later = new Map(after.map((pin) => [pin.evidence_set_id, pin]));
  const changed = before.filter((pin) => {
    const reread = later.get(pin.evidence_set_id);
    if (!reread || !same(pin.pinned_evaluator_definition_ids, reread.pinned_evaluator_definition_ids)) return true;
    return pin.readiness === "ready" && (reread.ready_at !== pin.ready_at || JSON.stringify(reread.references) !== JSON.stringify(pin.references));
  });
  const waited = before.filter((pin) => pin.readiness === "not_ready");
  const arrived = waited.filter((pin) => later.get(pin.evidence_set_id)?.readiness === "ready");
  return [
    check("the first run keeps its pins and frozen evidence after the swap", before.length > 0 && changed.length === 0 && after.length === before.length,
      changed.length === 0 ? `${before.length} unchanged` : changed.map((pin) => `${pin.item_path}:${pin.question_id}`).join(", ")),
    check("questions waiting at capture keep their original pins as they become ready", changed.length === 0,
      `${waited.length} waiting at capture (${[...new Set(waited.map((pin) => pin.not_ready_code))].join(",") || "none"}), ${arrived.length} ready since`),
  ];
}

export async function registrationScenario(io: ProofIo, capture: RegistrationCapture): Promise<ScenarioReport> {
  if (await io.stackAnswers()) return { id: "registration", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("this proof owns the stack", false, "a shadow is already running; this proof restarts it with an edited graders.json")] };
  const original = await io.readGraders();
  const committed = parsed(original);
  const edited = editedGraders(committed);
  const checks: ProofCheck[] = [];
  const registrations: RegistrationReadback[] = [];
  const pins: PinReadback[] = [];
  const runs: RunReference[] = [];
  let rows: GradingRows | null = null;
  const evidence = () => ({ ...NO_EVIDENCE, runs, registrations, pins, pinned_definitions: [...new Set(pins.flatMap((pin) => pin.pinned_evaluator_definition_ids))],
    source_revisions: [...new Set(pins.map((pin) => pin.revision_id))], item_paths: [...new Set(pins.map((pin) => `${pin.revision_id}${pin.item_path}`))],
    provider_request_count: rows?.requests_sent ?? null });
  const startOn = async (label: string, configuration: GraderConfiguration): Promise<boolean> => {
    const started = await io.startStack();
    checks.push(check(`the stack starts on the ${label} selection`, started.ok, started.ok ? "answered" : started.error.detail));
    if (!started.ok) return false;
    const settled = await settleObservation(io);
    checks.push(check(`observation is reachable on the ${label} selection`, observationSettled(settled.health), `health ${settled.health}; launcher ${settled.launcher}`));
    const registered = await registrationReadback(io, label);
    registrations.push(registered);
    const expected = planned(configuration).graders.map((grader) => grader.evaluator_definition_id);
    checks.push(check(`startup registered the ${label} graders`, same(registered.graders.map((grader) => grader.evaluator_definition_id), expected),
      registered.graders.map((grader) => `${grader.runner}:${grader.evaluator_definition_id}`).join(", ") || `health ${settled.health}`));
    return observationSettled(settled.health);
  };
  const captureRun = async (label: "first" | "second", configuration: GraderConfiguration): Promise<readonly PinReadback[] | null> => {
    const captured = await capture(label);
    checks.push(check(`the ${label} run is captured`, captured.report.status === "passed" && captured.run !== null,
      captured.report.checks.filter((entry) => !entry.passed).map((entry) => `${entry.name}: ${entry.detail}`).join("; ") || captured.run?.run_id || "no run"));
    if (!captured.run) return null;
    runs.push(captured.run);
    const read = await settledPins(io, captured.run.run_id, label);
    pins.push(...read);
    checks.push(...pinChecks(read, planned(configuration), label));
    return read;
  };
  try {
    if (!await startOn("committed", committed)) return { id: "registration", status: "failed", checks, evidence: evidence() };
    const first = await captureRun("first", committed);
    rows = await gradingRows(io);
    checks.push(check("capture and collection execute nothing", nothingGraded(rows), JSON.stringify(rows)));
    await io.stopStack();

    await io.writeGraders(JSON.stringify(edited, null, 2) + "\n");
    if (!await startOn("edited", edited)) return { id: "registration", status: "failed", checks, evidence: evidence() };
    const committedIds = planned(committed).evaluators.map((evaluator) => evaluator.evaluator_definition_id);
    const editedIds = planned(edited).evaluators.map((evaluator) => evaluator.evaluator_definition_id);
    const stored = registrations.at(-1)?.stored_evaluator_definition_ids ?? [];
    checks.push(check("the edit registered new definitions and kept every earlier one",
      [...committedIds, ...editedIds].every((id) => stored.includes(id)) && editedIds.some((id) => !committedIds.includes(id)),
      `${stored.length} stored; ${editedIds.filter((id) => !committedIds.includes(id)).length} new`));
    if (first && runs[0]) {
      const reread = await settledPins(io, runs[0].run_id, "first-after-swap");
      pins.push(...reread);
      checks.push(...retainedChecks(first, reread));
    }
    await captureRun("second", edited);
    rows = await gradingRows(io);
    checks.push(check("the swap and restart regrade nothing", nothingGraded(rows), JSON.stringify(rows)));
    return { id: "registration", status: scenarioStatus(checks), checks, evidence: evidence() };
  } finally {
    await io.stopStack();
    await io.writeGraders(original);
  }
}
