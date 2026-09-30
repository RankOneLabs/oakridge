import type { BlockedReason, CoreStatus, NextActor } from "../domain/records";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { PromptBundleEntry, StageOperatorRole } from "../domain/workflow";
import type { CommittedSessionLaunch } from "../domain/delegated-session";
import type { RunTransitionId } from "../domain/primitives";
import type { GateDisposition } from "../domain/gates";

export const BUILD_LAUNCH_REASONS = {
  build: [
    "initial_build",
    "revision_after_build_review",
    "revision_after_assessment",
    "pr_mismatch_correction",
    "retry_after_lost_attempt",
    "replacement_pr",
  ],
  assessment: ["initial_assessment", "retry_after_lost_attempt"],
} as const;

/**
 * This cohort owns the pure machine and its committed effect. Cohort c8 owns
 * runtime composition: decoding ingress events, constructing this machine
 * from the pinned build-stage contract, and submitting its command through
 * PostgresRunRecordWriter.decide.
 */

export type BuildSessionRole = keyof typeof BUILD_LAUNCH_REASONS;
export type BuildLaunchReason = (typeof BUILD_LAUNCH_REASONS)[BuildSessionRole][number];
export type BuildCohortPhase = "pending" | "builder_active" | "build_review" | "assessor_active" | "assessment_review" | "awaiting_merge" | "complete";
export type BuildEventDisposition = "transitioned" | "recorded_only";
export type BuildGateName = "build_review" | "assessment_review";

/**
 * A pull request an independent authority has checked for this cohort.
 *
 * `head_sha` is the forge head the check was made against — the git namespace.
 * `accepted_revision` is the *publication* the check is attached to, in the
 * machine's own namespace, and it is what freshness is read from: a verification
 * is good for the build it was made against and no later one.
 *
 * The two used to be one field called `revision`, compared against
 * `accepted_revision` to decide the same thing. They never matched: one side is
 * `pushed_head_sha` from the forge, the other is published artifact ids joined.
 * The gate therefore never opened on the real path, and the mismatch also nulled
 * the verification on every publication, which took the PR URL out of the
 * revision prompts that cite it.
 */
export interface VerifiedPullRequest {
  readonly url: string;
  readonly head_sha: string;
  /** Null when the verification arrived before the build published anything. */
  readonly accepted_revision: string | null;
}

export interface BuildCohortState {
  readonly phase: BuildCohortPhase;
  readonly required_build_set: readonly string[];
  readonly accepted_revision: string | null;
  readonly accepted_build_set: readonly string[];
  readonly verified_pull_request: VerifiedPullRequest | null;
  readonly assessment_artifact_id: string | null;
  readonly is_pull_request_merged: boolean;
}

export type BuildCohortEvent =
  | { readonly kind: "stage_started" }
  | { readonly kind: "build_artifact_recorded"; readonly revision: string; readonly output_name: string }
  /**
   * `accepted_revision` is supplied by the *driver*, from the cohort's committed
   * publications, not by whoever reported the pull request. Which of the two
   * facts commits first is not ordered — a publication wake and a verification
   * callback race — and stamping from committed rows makes both orders converge
   * rather than leaving the gate shut on the loser.
   */
  | { readonly kind: "pull_request_verified"; readonly head_sha: string; readonly pull_request_url: string;
    readonly accepted_revision: string | null }
  | { readonly kind: "builder_attempt_lost" }
  | { readonly kind: "build_review_approved" }
  | { readonly kind: "build_review_revision_requested" }
  | { readonly kind: "assessment_artifact_recorded"; readonly artifact_id: string }
  | { readonly kind: "assessment_outcome_observed"; readonly outcome: string }
  | { readonly kind: "assessor_attempt_lost" }
  | { readonly kind: "assessment_review_approved" }
  | { readonly kind: "assessment_review_revision_requested" }
  | { readonly kind: "pull_request_mismatch"; readonly pull_request_url: string }
  | { readonly kind: "replacement_pull_request_required"; readonly pull_request_url: string }
  | { readonly kind: "pull_request_merged"; readonly pull_request_url: string };

/**
 * The facts an outside authority reports about a cohort's pull request.
 *
 * The wire vocabulary, which differs from the machine's by exactly the stamp:
 * a reporter knows the forge head it verified and nothing about which publication
 * the cohort was on when it did. The driver fills that in from committed rows —
 * see `decodeBuildCohortEvent`.
 */
export type ReportedBuildCohortEvent =
  | { readonly kind: "pull_request_verified"; readonly head_sha: string; readonly pull_request_url: string }
  | { readonly kind: "pull_request_mismatch" | "replacement_pull_request_required" | "pull_request_merged";
    readonly pull_request_url: string };

export interface CommittedBuildPrompt {
  readonly template_path: string;
  readonly content: string;
}

/** The complete session launch decision stored in the transition effect. */
export interface BuildSessionLaunch {
  readonly session_role: BuildSessionRole;
  readonly launch_reason: BuildLaunchReason;
  readonly prompt: CommittedBuildPrompt;
  readonly contract_block: string;
}

export interface BuildCohortProjection {
  readonly status: CoreStatus;
  readonly blocked_reason: BlockedReason | null;
  readonly next_actor: NextActor | null;
  readonly outcome: JsonValue | null;
}

export interface BuildCohortTransitionEffect {
  readonly kind: "dev_flow_build_cohort_transition";
  readonly event: BuildCohortEvent;
  readonly disposition: BuildEventDisposition;
  readonly stage_data: BuildCohortState;
  readonly projected_status: BuildCohortProjection;
  readonly session_launch: BuildSessionLaunch | null;
}

export interface BuildCohortEventResult {
  readonly disposition: BuildEventDisposition;
  readonly state: BuildCohortState;
  readonly projection: BuildCohortProjection;
  readonly launch: BuildSessionLaunch | null;
  readonly effect: BuildCohortTransitionEffect;
}

/** Attach the row identity after the transition has committed. */
export const committedSessionLaunch = (
  transition_id: RunTransitionId,
  launch: BuildSessionLaunch,
  existing_pull_request: string | null,
): CommittedSessionLaunch => ({
  reason: { transition_id, name: launch.launch_reason },
  session_role: launch.session_role,
  prompt: launch.prompt,
  existing_pull_request,
});

export interface BuildCohortMachine {
  readonly required_build_set: readonly string[];
  readonly prompts: ReadonlyMap<string, CommittedBuildPrompt>;
}

export interface BuildCohortMachineConfig {
  readonly required_build_set: readonly string[];
  readonly prompts: readonly PromptBundleEntry[];
}

const launchKey = (role: StageOperatorRole, reason: string): string => `${role}:${reason}`;
const unique = (values: readonly string[]): readonly string[] => [...new Set(values)].sort();

/**
 * Validates the adapter's role × reason contract once, before a cohort can
 * run. A later transition therefore selects one already pinned prompt cell;
 * it never consults a mutable bundle while rendering a session.
 */
export const createBuildCohortMachine = (config: BuildCohortMachineConfig): Result<BuildCohortMachine, string> => {
  const required = unique(config.required_build_set);
  if (required.length === 0 || required.some((name) => name.trim().length === 0)) return err("required_build_set must contain non-empty output names");
  if (required.length !== config.required_build_set.length) return err("required_build_set contains a duplicate output name");
  const prompts = new Map<string, CommittedBuildPrompt>();
  for (const [role, reasons] of Object.entries(BUILD_LAUNCH_REASONS) as [BuildSessionRole, readonly BuildLaunchReason[]][]) {
    for (const reason of reasons) {
      const matches = config.prompts.filter((entry) => entry.session_role === role && entry.launch_reason === reason);
      if (matches.length !== 1) return err(`prompt matrix requires exactly one ${role}:${reason} cell; found ${matches.length}`);
      const selected = matches[0]!;
      prompts.set(launchKey(role, reason), { template_path: selected.template_path, content: selected.content });
    }
  }
  if (config.prompts.length !== prompts.size) return err(`prompt matrix contains ${config.prompts.length - prompts.size} unsupported cell(s)`);
  return ok({ required_build_set: required, prompts });
};

export const initialBuildCohortState = (required_build_set: readonly string[]): BuildCohortState => ({
  phase: "pending",
  required_build_set: unique(required_build_set),
  accepted_revision: null,
  accepted_build_set: [],
  verified_pull_request: null,
  assessment_artifact_id: null,
  is_pull_request_merged: false,
});

/**
 * Every required output published under one revision, and a pull request
 * verified for that same revision.
 *
 * The third clause is what keeps a stale verification from opening the gate: the
 * operator is being asked to review a pull request, so the one they are shown
 * has to be the one the published work is in.
 */
export const isBuildReviewReady = (input: Pick<BuildCohortState,
  "required_build_set" | "accepted_revision" | "accepted_build_set" | "verified_pull_request">): boolean =>
  input.accepted_revision !== null
  && input.required_build_set.every((name) => input.accepted_build_set.includes(name))
  && input.verified_pull_request?.accepted_revision === input.accepted_revision;

/** Manual gate decisions enter the same event boundary as every other fact. */
export const selectBuildGateEvent = (gate: BuildGateName, disposition: GateDisposition): Result<BuildCohortEvent, string> => {
  if (disposition === "release") return ok({ kind: gate === "build_review" ? "build_review_approved" : "assessment_review_approved" });
  if (disposition === "revise") return ok({ kind: gate === "build_review" ? "build_review_revision_requested" : "assessment_review_revision_requested" });
  return err(`${gate} does not have a terminal route`);
};

export const projectBuildCohortState = (state: BuildCohortState): BuildCohortProjection => {
  if (state.phase === "pending") return { status: "pending", blocked_reason: null, next_actor: "core", outcome: null };
  if (state.phase === "builder_active" || state.phase === "assessor_active") {
    return { status: "active", blocked_reason: null, next_actor: "agent", outcome: null };
  }
  if (state.phase === "build_review" || state.phase === "assessment_review") {
    return { status: "blocked", blocked_reason: "gate", next_actor: "operator", outcome: null };
  }
  if (state.phase === "awaiting_merge") return { status: "blocked", blocked_reason: "external", next_actor: "external", outcome: null };
  return { status: "complete", blocked_reason: null, next_actor: null, outcome: { kind: "succeeded" } };
};

const promptFor = (machine: BuildCohortMachine, session_role: BuildSessionRole, launch_reason: BuildLaunchReason): CommittedBuildPrompt => {
  const prompt = machine.prompts.get(launchKey(session_role, launch_reason));
  if (!prompt) throw new Error(`validated prompt cell disappeared: ${session_role}:${launch_reason}`);
  return prompt;
};

const launch = (
  machine: BuildCohortMachine,
  state: BuildCohortState,
  session_role: BuildSessionRole,
  launch_reason: BuildLaunchReason,
): BuildSessionLaunch => {
  const lines = ["## Generated session contract", `Role: ${session_role}`, `Launch reason: ${launch_reason}`];
  if (session_role === "build" && launch_reason !== "initial_build" && state.verified_pull_request) {
    lines.push(`Existing PR: ${state.verified_pull_request.url}`);
  }
  return { session_role, launch_reason, prompt: promptFor(machine, session_role, launch_reason), contract_block: lines.join("\n") };
};

const restartBuilder = (state: BuildCohortState): BuildCohortState => ({
  ...state,
  phase: "builder_active",
  accepted_revision: null,
  accepted_build_set: [],
  assessment_artifact_id: null,
  is_pull_request_merged: false,
});

/**
 * The verification is *kept* across a republication rather than dropped.
 *
 * A build that publishes again is the same pull request with more commits on it,
 * so the URL stays true and the revision prompts keep citing it; what changes is
 * that the verification is now stale, which `isBuildReviewReady` reads off the
 * stamp. Dropping it here instead discarded the URL the `revision_after_*`
 * prompts are built from.
 */
const observeBuildArtifact = (state: BuildCohortState, event: Extract<BuildCohortEvent, { readonly kind: "build_artifact_recorded" }>): BuildCohortState => {
  const sameRevision = state.accepted_revision === event.revision;
  const accepted_build_set = unique([...(sameRevision ? state.accepted_build_set : []), event.output_name]);
  const observed = { ...state, accepted_revision: event.revision, accepted_build_set };
  return isBuildReviewReady(observed) ? { ...observed, phase: "build_review" } : observed;
};

/**
 * Only `builder_active` opens the gate. A verification also arrives while the
 * operator is already holding the gate, and after the assessor has taken over —
 * re-verification is a freshness sweep, not a rewind — and a readiness test that
 * set the phase unconditionally would send an `awaiting_merge` cohort back to
 * `build_review`.
 */
const observeVerifiedPullRequest = (state: BuildCohortState, event: Extract<BuildCohortEvent, { readonly kind: "pull_request_verified" }>): BuildCohortState => {
  const observed = { ...state, verified_pull_request: { url: event.pull_request_url, head_sha: event.head_sha,
    accepted_revision: event.accepted_revision } };
  return state.phase === "builder_active" && isBuildReviewReady(observed) ? { ...observed, phase: "build_review" } : observed;
};

interface AppliedEvent { readonly state: BuildCohortState; readonly disposition: BuildEventDisposition; readonly launch: BuildSessionLaunch | null }
const recorded = (state: BuildCohortState): AppliedEvent => ({ state, disposition: "recorded_only", launch: null });
const transitioned = (state: BuildCohortState, sessionLaunch: BuildSessionLaunch | null = null): AppliedEvent =>
  ({ state, disposition: "transitioned", launch: sessionLaunch });

const applyEvent = (machine: BuildCohortMachine, state: BuildCohortState, event: BuildCohortEvent): AppliedEvent => {
  if (state.phase === "complete") return recorded(state);
  if (event.kind === "pull_request_merged") {
    if (state.phase === "awaiting_merge" && state.verified_pull_request?.url === event.pull_request_url) {
      return transitioned({ ...state, phase: "complete", is_pull_request_merged: true });
    }
    return recorded({ ...state, is_pull_request_merged: state.verified_pull_request?.url === event.pull_request_url || state.is_pull_request_merged });
  }
  if (event.kind === "stage_started" && state.phase === "pending") {
    const next = { ...state, phase: "builder_active" } as const;
    return transitioned(next, launch(machine, next, "build", "initial_build"));
  }
  if (state.phase === "builder_active") {
    if (event.kind === "build_artifact_recorded") {
      const next = observeBuildArtifact(state, event);
      return next.phase === state.phase ? recorded(next) : transitioned(next);
    }
    if (event.kind === "builder_attempt_lost") return transitioned(state, launch(machine, state, "build", "retry_after_lost_attempt"));
  }
  if (event.kind === "pull_request_verified" && state.phase !== "pending") {
    const next = observeVerifiedPullRequest(state, event);
    return next.phase === state.phase ? recorded(next) : transitioned(next);
  }
  if (event.kind === "pull_request_mismatch" && state.phase !== "pending") {
    const next = restartBuilder(state);
    return transitioned(next, launch(machine, state, "build", "pr_mismatch_correction"));
  }
  if (event.kind === "replacement_pull_request_required" && state.phase !== "pending") {
    const next = { ...restartBuilder(state), verified_pull_request: null };
    return transitioned(next, launch(machine, state, "build", "replacement_pr"));
  }
  if (state.phase === "build_review") {
    if (event.kind === "build_review_approved") {
      const next = { ...state, phase: "assessor_active" } as const;
      return transitioned(next, launch(machine, next, "assessment", "initial_assessment"));
    }
    if (event.kind === "build_review_revision_requested") {
      const next = restartBuilder(state);
      return transitioned(next, launch(machine, state, "build", "revision_after_build_review"));
    }
  }
  if (state.phase === "assessor_active") {
    if (event.kind === "assessment_artifact_recorded") return transitioned({ ...state, phase: "assessment_review", assessment_artifact_id: event.artifact_id });
    if (event.kind === "assessor_attempt_lost") return transitioned(state, launch(machine, state, "assessment", "retry_after_lost_attempt"));
  }
  if (state.phase === "assessment_review") {
    if (event.kind === "assessment_review_revision_requested") {
      const next = restartBuilder(state);
      return transitioned(next, launch(machine, state, "build", "revision_after_assessment"));
    }
    if (event.kind === "assessment_review_approved") {
      return transitioned({ ...state, phase: state.is_pull_request_merged ? "complete" : "awaiting_merge" });
    }
  }
  return recorded(state);
};

/** Pure transition pipeline used by every dev-flow build event ingress. */
export const applyBuildCohortEvent = (
  machine: BuildCohortMachine,
  state: BuildCohortState,
  event: BuildCohortEvent,
): BuildCohortEventResult => {
  const applied = applyEvent(machine, state, event);
  const projection = projectBuildCohortState(applied.state);
  const effect: BuildCohortTransitionEffect = {
    kind: "dev_flow_build_cohort_transition",
    event,
    disposition: applied.disposition,
    stage_data: applied.state,
    projected_status: projection,
    session_launch: applied.launch,
  };
  return { disposition: applied.disposition, state: applied.state, projection, launch: applied.launch, effect };
};
