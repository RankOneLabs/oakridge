/**
 * Launches the committed development workflow on the shadow and retains its real
 * capture. Requires a reachable gated-review endpoint and the installed Codex ACP
 * agent's normal authentication: this spends real agent turns, and with
 * --through assessment runs the input's actual build.
 *
 * Everything goes through the shadow's own services. Planning reviews in this
 * throwaway run are accepted; an assessment, closed-PR or integration review
 * never is. The run is canceled once its target artifact arrives. It passes only
 * when the ordered feed then covers the whole run and the service serves the
 * target revision; observation down before launch fails before any turn is spent.
 */
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { defaultModelForRuntime } from "../../kbbl/core/runtime";
import { resolveLaunchableDefinition } from "../../workflow-config/src/definition-store";
import { NO_EVIDENCE, scenarioStatus, type ProofCheck, type RunReference, type ScenarioReport } from "./proof-contract";
import { awaitRunCapture, runCaptureChecks } from "./run-capture";
import { observationSettled, readCapture, settleObservation } from "./scenarios";
import type { ProofIo } from "./shadow-session";

/** Mirrors the committed development.yaml input and existing launch settings. */
export const sourceRunInputSchema = z.object({ title: z.string(), spec: z.string(), primary_repository_key: z.string(),
  final_merge_policy: z.enum(["require_merge", "allow_close_without_merge"]), repositories: z.array(z.object({
    key: z.string(), preparation: z.object({ repository_path: z.string(), expected_head: z.string().nullable() }),
    forge: z.object({ owner: z.string(), name: z.string(), build_base: z.string(), final_base: z.string() }),
  })).min(1) });
export type SourceRunInput = z.infer<typeof sourceRunInputSchema>;
export type SourceRunTarget = "analysis" | "plan" | "brief" | "assessment";
export interface SourceRunOptions { readonly input: SourceRunInput; readonly directory: string; readonly through: SourceRunTarget;
  readonly timeout_ms?: number; readonly capture_timeout_ms?: number;
  /** Runs once the run has launched and before it is driven; a failed check ends the run there. */
  readonly after_launch?: (run: RunReference) => Promise<ProofCheck>;
  /** `deferred` leaves the capture wait to a caller that keeps observation down while the run progresses. */
  readonly capture?: "await" | "deferred";
  /** The run's own automatic-grading choice, committed with its launch. Off unless set. */
  readonly grading_enabled?: boolean;
  /** Steps around a review the run accepts, each taken once: `before` while it still awaits, `after` once accepted. */
  readonly reviews?: readonly ReviewCheckpoint[];
  /** How many units must hold the target artifact before the run is done. One unless set. */
  readonly target_units?: number }
/** One explicit association, as the tasks approval's caller supplies it. */
export interface SuppliedLink { readonly source_revision_id: string; readonly item_path: string; readonly task_ids: readonly string[] }
/** What a proof does around one accepted review. `target` is the revision the review decides. A failed `before` ends the run there. */
export interface ReviewCheckpoint {
  readonly review: string;
  before?(run: RunReference, target: string): Promise<ProofCheck>;
  after?(run: RunReference, target: string): Promise<ProofCheck>;
  /** Sent back once per unit before that unit's acceptance, so the run really revises the artifact. */
  readonly revision_feedback?: string;
  /** Explicit links the acceptance carries. */
  analysis_links?(run: RunReference, target: string): readonly SuppliedLink[];
}

const POLL_MS = 1_000;
const DEFAULT_TIMEOUT_MS = 1_800_000;
const DECISION_ATTEMPTS = 30;

interface InspectView {
  readonly artifacts: readonly { readonly artifact_key: string; readonly latest_revision: unknown }[];
  readonly attention: readonly { readonly kind: string; readonly review?: string; readonly unit_id?: string; readonly target?: unknown }[];
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(`${path}.pending`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.pending`, path);
}

/** Only the reviews the requested capture needs. */
const acceptableReviews = (through: SourceRunTarget): readonly string[] => through === "analysis" ? []
  : ["analysis_review", "spec_review", "tasks_review", "plan_review", ...(through === "assessment" ? ["brief_review"] : [])];

/**
 * One decision, until its result is known. A failed call may have committed with its response lost, and
 * the next poll would no longer show that review, so it is repeated with the same request id: a replay
 * answers from the commit's receipt and repeats nothing. Returns why it never became known.
 */
async function decideUntilKnown(io: ProofIo, path: string, body: { readonly [field: string]: unknown }): Promise<string | null> {
  const request = { ...body, request_id: crypto.randomUUID() };
  let detail = "never attempted";
  for (let attempt = 0; attempt < DECISION_ATTEMPTS; attempt++) {
    if (attempt > 0) await io.sleep(POLL_MS);
    const sent = await io.dbos(path, request);
    if (sent.ok) return null;
    detail = sent.error.detail;
  }
  return `after ${DECISION_ATTEMPTS} attempts: ${detail}`;
}

interface ReviewProgress { readonly taken: Set<string>; readonly revised: Set<string>; readonly prepared: Set<string> }
/** Accepts what the capture needs, taking each review's checkpoint steps. Returns the step or decision that failed. */
async function acceptReviews(io: ProofIo, run: RunReference, inspect: InspectView, options: SourceRunOptions, progress: ReviewProgress): Promise<ProofCheck | null> {
  const { run_id } = run;
  const { taken, revised, prepared } = progress;
  for (const review of inspect.attention) {
    if (review.kind !== "awaiting_review" || !review.review || !acceptableReviews(options.through).includes(review.review)) continue;
    const target = typeof review.target === "string" ? review.target : "";
    const configured = options.reviews?.find((candidate) => candidate.review === review.review);
    const unit_review = JSON.stringify([review.unit_id, review.review]);
    const decide = `/api/runs/${run_id}/units/${encodeURIComponent(review.unit_id ?? "")}/reviews/${review.review}/decide`;
    if (configured?.revision_feedback && !revised.has(unit_review)) {
      revised.add(unit_review);
      const unknown = await decideUntilKnown(io, decide, { decision: "request_changes", target: review.target, payload: { feedback: configured.revision_feedback } });
      if (unknown) return { name: `${review.review} is sent back for a revision`, passed: false, detail: unknown };
      continue;
    }
    const checkpoint = taken.has(review.review) ? undefined : configured;
    if (checkpoint?.before && !prepared.has(review.review)) {
      const step = await checkpoint.before(run, target);
      if (!step.passed) return step;
      prepared.add(review.review);
    }
    const unknown = await decideUntilKnown(io, decide, { decision: "accept", target: review.target,
      payload: { feedback: "Accepted for the isolated live verification run." },
      ...(checkpoint?.analysis_links ? { analysis_links: checkpoint.analysis_links(run, target) } : {}) });
    if (unknown) return { name: `${review.review} is accepted`, passed: false, detail: unknown };
    if (checkpoint) {
      taken.add(review.review);
      const step = await checkpoint.after?.(run, target);
      if (step && !step.passed) return step;
    }
  }
  return null;
}

async function driveToTarget(io: ProofIo, run: RunReference, options: SourceRunOptions): Promise<ProofCheck> {
  const { run_id } = run;
  const progress: ReviewProgress = { taken: new Set(), revised: new Set(), prepared: new Set() };
  const deadline = io.now() + (options.timeout_ms ?? DEFAULT_TIMEOUT_MS);
  while (io.now() < deadline) {
    const read = await io.dbos(`/api/runs/${run_id}/inspect`);
    if (!read.ok) return { name: "the run reaches its target", passed: false, detail: read.error.detail };
    const inspect = read.value as InspectView;
    await writeJson(join(options.directory, "inspect.json"), inspect);
    if (inspect.artifacts.filter((artifact) => artifact.latest_revision && artifact.artifact_key === options.through).length >= (options.target_units ?? 1)) {
      // A proof's steps are its checks: a run that got here without them proved nothing they cover.
      const skipped = (options.reviews ?? []).map((checkpoint) => checkpoint.review).filter((review) => !progress.taken.has(review));
      return skipped.length > 0 ? { name: "every review step the proof asked for ran", passed: false, detail: `never taken: ${skipped.join(", ")}` }
        : { name: "the run reaches its target", passed: true, detail: options.through };
    }
    const stalled = inspect.attention.find((item) => item.kind !== "awaiting_review");
    if (stalled) return { name: "the run reaches its target", passed: false, detail: `needs intervention: ${JSON.stringify(stalled)}` };
    const refused = await acceptReviews(io, run, inspect, options, progress);
    if (refused) return refused;
    await io.sleep(POLL_MS);
  }
  return { name: "the run reaches its target", passed: false, detail: "timed out; partial inspect.json retained" };
}

/** Retained under the proof's report directory: run.json, inspect.json, authority-rows.json. */
export async function sourceRunScenario(io: ProofIo, options: SourceRunOptions): Promise<ScenarioReport> {
  await mkdir(options.directory, { recursive: true });
  const definition = resolveLaunchableDefinition("development");
  if (!definition.ok) return { id: "source-run", status: "failed", evidence: NO_EVIDENCE,
    checks: [{ name: "the development definition resolves", passed: false, detail: JSON.stringify(definition.error) }] };
  const observation = await settleObservation(io);
  if (!observationSettled(observation.health)) return { id: "source-run", status: "failed", evidence: NO_EVIDENCE,
    checks: [{ name: "observation is reachable before the run launches", passed: false, detail: `health ${observation.health}; launcher ${observation.launcher}` }] };
  const settings = { harness: "codex", model: defaultModelForRuntime("codex"), effort: null };
  const launched = await io.dbos("/api/runs", { request_id: crypto.randomUUID(), definition_id: definition.value.definition_id, input: options.input,
    config: { sessions: { analysis: { author: settings, spec_editor: settings }, planning: { planner: settings }, brief: { writer: settings },
      cohort: { builder: settings, assessor: settings } }, grading_enabled: options.grading_enabled ?? false } });
  const run_id = launched.ok ? (launched.value as { readonly run_id?: string }).run_id ?? null : null;
  if (!run_id) return { id: "source-run", status: "failed", evidence: NO_EVIDENCE,
    checks: [{ name: "the run launches", passed: false, detail: launched.ok ? "no run id" : launched.error.detail }] };
  const run = { run_id, definition_id: definition.value.definition_id };
  await writeJson(join(options.directory, "run.json"), run);
  const prepared = options.after_launch ? await options.after_launch(run) : null;
  const reached = prepared && !prepared.passed ? null : await driveToTarget(io, run, options);
  const canceled = await io.dbos(`/api/runs/${run_id}/cancel`, { request_id: crypto.randomUUID() });
  const run_capture = options.capture === "deferred" ? null
    : await awaitRunCapture(io, { run_id, target_artifact: options.through }, options.capture_timeout_ms);
  const rows = await io.shadowQuery(io.state.postgres.authority_database, `SELECT coalesce(json_agg(event ORDER BY commit_txid, id), '[]') FROM
    (SELECT id, commit_txid, created_at, payload, run_id, unit_id FROM authority.event WHERE run_id = '${run_id}') event`);
  if (rows.ok) await writeJson(join(options.directory, "authority-rows.json"), JSON.parse(rows.value));
  const capture = run_capture ? await readCapture(io) : null;
  const checks: readonly ProofCheck[] = [...(prepared ? [prepared] : []), ...(reached ? [reached] : []),
    { name: "the run is canceled", passed: canceled.ok, detail: canceled.ok ? "accepted" : canceled.error.detail },
    { name: "the authority rows are retained", passed: rows.ok, detail: rows.ok ? "authority-rows.json" : rows.error.detail },
    ...(run_capture ? runCaptureChecks(run_capture) : [])];
  return { id: "source-run", status: scenarioStatus(checks), checks,
    evidence: { ...NO_EVIDENCE, runs: [run], capture, run_capture, source_revisions: run_capture?.source_revisions ?? [] } };
}
