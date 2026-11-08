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
export type ScenarioId = "runtime" | "live" | "source-run" | "registration" | "grading";

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
/** One cited source inside frozen evidence: where it came from. Its content is in `frozen_evidence`. */
export interface ReferenceReadback {
  readonly ref: string;
  readonly source: string;
  readonly revision_id: string | null;
  readonly item_path: string | null;
  readonly run_id: string | null;
  readonly input_path: string | null;
  readonly repository_key: string | null;
  readonly commit_sha: string | null;
  readonly path: string | null;
  readonly line_range: { readonly start: number; readonly end: number } | null;
  readonly is_absent: boolean | null;
  readonly reported_by: string | null;
}
/** One frozen evidence set exactly as the service served it when first seen ready, content included. */
export interface FrozenEvidenceReadback {
  readonly checkpoint: string;
  readonly run_id: string;
  readonly occurrence_id: string;
  readonly item_path: string;
  readonly question_id: string;
  readonly evidence_set_id: string;
  readonly ready_at: string | null;
  readonly references: readonly unknown[];
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
/** One pinned machine measurement of one item, as /v1/items/:id/measurements served it. */
export interface MeasurementReadback {
  readonly checkpoint: string;
  readonly run_id: string;
  readonly occurrence_id: string;
  readonly revision_id: string;
  readonly item_path: string;
  readonly item_kind: string;
  readonly question_id: string;
  readonly question_version: string;
  readonly evidence_set_id: string;
  readonly readiness: "ready" | "not_ready";
  readonly is_human_ready: boolean;
  readonly evaluator_definition_id: string;
  readonly model: string | null;
  readonly execution_id: string | null;
  /** not_ready, grading_off, awaiting_admission, pending, budget_deferred, failed or answered. */
  readonly state: string;
  readonly detail: string | null;
  readonly observation_id: string | null;
  readonly answer: unknown;
  readonly attempts: readonly { readonly attempt: number; readonly request_sent: boolean; readonly outcome: string | null;
    readonly failure_category: string | null; readonly charged_cost: number; readonly provider_request_id: string | null }[];
}
/** A run's automatic-grading spend as /v1/runs/:run_id/grading-spend served it, at one checkpoint. */
export interface SpendReadback {
  readonly checkpoint: string;
  readonly run_id: string;
  /** The grading choice the run's launch committed, read back from the captured launch delivery. */
  readonly grading_enabled: boolean | null;
  /** The exact config the run's launch delivered, as observation captured it. */
  readonly captured_config: unknown;
  readonly committed: number;
  readonly requests_sent: number;
  readonly attempts: number;
  readonly executions: Readonly<Record<string, number>>;
}
/** A run's launch config twice over: as observation captured it from the launch delivery, and as
 * the authority committed it. Both are the raw stored JSON, or null when there is none. */
export interface LaunchConfigReadback {
  readonly checkpoint: string;
  readonly run_id: string;
  readonly captured_config: unknown;
  readonly authority_config: unknown;
}
/** One claim call of a worker, and what it returned. */
export interface ClaimReadback {
  readonly worker: string;
  readonly kind: string;
  readonly execution_id: string | null;
  readonly claim_attempt: number | null;
}
/** A claim presented for settlement after it stopped being current, and how each fenced write answered. */
export interface StaleSettlementReadback {
  readonly case: "earlier_owner" | "older_attempt" | "killed_service";
  readonly execution_id: string;
  readonly lease_owner: string;
  readonly claim_attempt: number;
  readonly mark_request_sent: boolean;
  readonly complete: string;
  readonly fail: string;
}
/** A second observation worker on the shadow's own database, with the service down. */
export interface SecondWorkerReadback {
  readonly run_id: string;
  readonly run_spend: number;
  readonly estimate_per_call: number;
  readonly before: SpendReadback;
  readonly simultaneous: readonly ClaimReadback[];
  readonly after_claims: SpendReadback;
  readonly reclaims: readonly ClaimReadback[];
  readonly stale: readonly StaleSettlementReadback[];
  /** The reclaiming worker's own settlement: its kind and, when completed, the observation it wrote. */
  readonly settlement: { readonly kind: string; readonly observation_id: string | null; readonly detail: string | null } | null;
  readonly after: SpendReadback;
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
  readonly frozen_evidence: readonly FrozenEvidenceReadback[];
  readonly measurements: readonly MeasurementReadback[];
  readonly spend: readonly SpendReadback[];
  readonly launch_configs: readonly LaunchConfigReadback[];
  readonly second_worker: SecondWorkerReadback | null;
}
export const NO_EVIDENCE: ScenarioEvidence = { runs: [], capture: null, run_capture: null, authority: null, source_revisions: [], item_paths: [],
  pinned_definitions: [], execution_ids: [], provider_attempt_ids: [], observation_ids: [], provider_request_count: null, pwa_readback: [],
  registrations: [], pins: [], frozen_evidence: [], measurements: [], spend: [], launch_configs: [], second_worker: null };

export interface ScenarioReport {
  readonly id: ScenarioId;
  readonly status: ScenarioStatus;
  readonly checks: readonly ProofCheck[];
  readonly evidence: ScenarioEvidence;
}
/** Proof the program does not perform yet, and who adds it. Listed so a passing report cannot read as complete. */
export interface PendingScenario { readonly id: string; readonly owner: string; readonly reason?: string }
export const PENDING_SCENARIOS: readonly PendingScenario[] = [
  { id: "relations-and-composites", owner: "task-lineage-composites" },
  { id: "first-assessment-finding-end-to-end", owner: "operator-item-workspace" },
  { id: "human-grading-and-pwa-readback", owner: "operator-item-workspace" },
  { id: "same-finding-correctness-awaits-subject-build", owner: "operator",
    reason: "Correctness alone waits only when an assessment names a subject build observation has not captured. Live assessments are "
      + "published with subject null, and the ordered feed captures any named subject before its assessment, so a real run cannot "
      + "reach the split; it is proven offline in observation/tests/execution-lifecycle.test.ts. Reaching it live needs a product change." },
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
