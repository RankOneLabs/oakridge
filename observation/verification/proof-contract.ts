/**
 * What a proof reads and writes. Later cohorts extend these types and the
 * scenarios in scenarios.ts; every field holds what was actually observed, and a
 * value not yet observed is null, never an estimate.
 */
import { z } from "zod";

/** Exactly what `scripts/oakridge-shadow --print-state` emits: the one resolved shadow. */
export const launcherStateSchema = z.object({
  name: z.string(),
  state_dir: z.string(),
  kbbl: z.object({ port: z.number(), url: z.string(), data_dir: z.string() }),
  dbos: z.object({ port: z.number(), url: z.string() }),
  postgres: z.object({ container: z.string(), volume: z.string(), port: z.number(), authority_database: z.string() }),
  observation: z.object({ port: z.number(), url: z.string(), database: z.string(), namespace: z.string(),
    ingest_token_file: z.string(), read_token_file: z.string(), grade_token_file: z.string(), status_file: z.string() }),
  provider_env_file: z.string(),
});
export type LauncherState = z.infer<typeof launcherStateSchema>;

/** The launcher's own record of its observation child: scripts/oakridge-start writes it. */
export const observationStatusSchema = z.object({
  state: z.enum(["starting", "preflight_failed", "running", "exited", "stopped"]),
  detail: z.string(),
  recorded_at: z.string(),
});
export type ObservationStatus = z.infer<typeof observationStatusSchema>;

export interface ProofFailure { readonly operation: string; readonly entity_id: string; readonly detail: string }
export interface ProofCheck { readonly name: string; readonly passed: boolean; readonly detail: string }
export type ScenarioStatus = "passed" | "failed" | "not_run";
export type ScenarioId = "runtime" | "live" | "source-run" | "registration";

export interface RunReference { readonly run_id: string; readonly definition_id: string }
/** Position in the ordered feed, as the authority and the service each report it. */
export interface CaptureReference {
  readonly authority_head: string | null;
  readonly service_cursor: string | null;
}
/** Which run a capture check covers, and the artifact it had to reach, if any. */
export interface RunCaptureRequest { readonly run_id: string; readonly target_artifact: string | null }
export interface UnmappedEvent { readonly event_id: string; readonly event_kind: string; readonly reason: string }
/** What observation and the publisher said when a capture wait ended. */
export interface RunCaptureDiagnostics { readonly health: string; readonly launcher: string; readonly publisher_failures: readonly string[] }
/** One run compared event by event: the authority's rows against the service's recorded outcomes. */
export interface RunCapture extends RunCaptureRequest {
  readonly authority_events: number;
  readonly delivered_events: number;
  readonly authority_last: string | null;
  readonly service_cursor: string | null;
  readonly cursor_reached_run: boolean;
  readonly undelivered_event_ids: readonly string[];
  readonly unmapped: readonly UnmappedEvent[];
  readonly source_revisions: readonly string[];
  /** The target revision as the service served it back; null until it does. */
  readonly target_revision: string | null;
  readonly read_failures: readonly string[];
  /** Null on a single read, which is not a finished wait. */
  readonly diagnostics: RunCaptureDiagnostics | null;
}
/** One cited source inside frozen evidence: where it came from, never its content. */
export interface ReferenceReadback {
  readonly ref: string;
  readonly source: string;
  readonly revision_id: string | null;
  readonly item_path: string | null;
  readonly commit_sha: string | null;
  readonly path: string | null;
}
/** One question pinned to one captured item, as the running service served it back. */
export interface PinReadback {
  readonly checkpoint: string;
  readonly run_id: string;
  readonly occurrence_id: string;
  readonly revision_id: string;
  readonly item_path: string;
  readonly item_kind: string;
  readonly question_id: string;
  readonly question_version: string;
  readonly evidence_set_id: string;
  readonly pinned_evaluator_definition_ids: readonly string[];
  readonly readiness: "ready" | "not_ready";
  readonly not_ready_code: string | null;
  readonly ready_at: string | null;
  readonly references: readonly ReferenceReadback[];
}
/** What the service registered at one startup: its health report and the stored definitions. */
export interface RegistrationReadback {
  readonly checkpoint: string;
  readonly graders: readonly { readonly runner: string; readonly evaluator_definition_id: string }[];
  readonly stored_evaluator_definition_ids: readonly string[];
}
export interface AuthorityCount { readonly events_before: number | null; readonly events_after: number | null }
/** A scenario's evidence. Each list holds actual ids read back from the running services. */
export interface ScenarioEvidence {
  readonly runs: readonly RunReference[];
  readonly capture: CaptureReference | null;
  readonly run_capture: RunCapture | null;
  readonly authority: AuthorityCount | null;
  readonly source_revisions: readonly string[];
  readonly item_paths: readonly string[];
  readonly pinned_definitions: readonly string[];
  readonly execution_ids: readonly string[];
  readonly provider_attempt_ids: readonly string[];
  readonly observation_ids: readonly string[];
  /** Null until a scenario counts real requests; zero means counted and none were sent. */
  readonly provider_request_count: number | null;
  readonly pwa_readback: readonly string[];
  readonly registrations: readonly RegistrationReadback[];
  readonly pins: readonly PinReadback[];
}
export const NO_EVIDENCE: ScenarioEvidence = { runs: [], capture: null, run_capture: null, authority: null, source_revisions: [], item_paths: [],
  pinned_definitions: [], execution_ids: [], provider_attempt_ids: [], observation_ids: [], provider_request_count: null, pwa_readback: [],
  registrations: [], pins: [] };

export interface ScenarioReport {
  readonly id: ScenarioId;
  readonly status: ScenarioStatus;
  readonly checks: readonly ProofCheck[];
  readonly evidence: ScenarioEvidence;
}
/** Proof the program does not perform yet, and who adds it. Listed so a passing report cannot read as complete. */
export interface PendingScenario { readonly id: string; readonly owner: string }
export const PENDING_SCENARIOS: readonly PendingScenario[] = [
  { id: "not-ready-arrival-on-real-capture", owner: "configured-question-evidence" },
  { id: "real-provider-requests-and-recovery", owner: "automatic-execution-lifecycle" },
  { id: "relations-and-composites", owner: "task-lineage-composites" },
  { id: "first-assessment-finding-end-to-end", owner: "operator-item-workspace" },
  { id: "human-grading-and-pwa-readback", owner: "operator-item-workspace" },
];

export interface SourceIdentity { readonly git_head: string | null; readonly worktree_clean: boolean | null }
export interface ProofReport {
  readonly proof_id: string;
  readonly started_at: string;
  readonly finished_at: string;
  readonly source: SourceIdentity;
  readonly launcher: LauncherState | null;
  readonly status: "passed" | "failed";
  readonly scenario: ScenarioReport;
  readonly pending: readonly PendingScenario[];
}

export const scenarioStatus = (checks: readonly ProofCheck[]): ScenarioStatus =>
  checks.length > 0 && checks.every((check) => check.passed) ? "passed" : "failed";

/** A proof passes only by running a scenario whose every check passed. */
export const reportStatus = (scenario: ScenarioReport): ProofReport["status"] => scenario.status === "passed" ? "passed" : "failed";

/** Secrets by value: the serialized report must contain none of them. */
export function redactReport(text: string, secrets: readonly string[]): { readonly text: string; readonly redacted: number } {
  let redacted = 0;
  const cleaned = secrets.filter((secret) => secret.length > 0).reduce((current, secret) => {
    const pieces = current.split(secret);
    redacted += pieces.length - 1;
    return pieces.join("[redacted]");
  }, text);
  return { text: cleaned, redacted };
}
