import { describe, expect, test } from "bun:test";

import {
  BUILD_LAUNCH_REASONS,
  applyBuildCohortEvent,
  createBuildCohortMachine,
  initialBuildCohortState,
  isBuildReviewReady,
  type BuildCohortEvent,
  type BuildCohortPhase,
  type BuildCohortState,
  type BuildEventDisposition,
} from "../../src/adapters/dev-flow-build";
import type { PromptBundleEntry } from "../../src/domain/workflow";
import { createDevFlowAdapterRegistry } from "../../src/adapters/dev-flow";

const prompt = (session_role: "build" | "assessment", launch_reason: string): PromptBundleEntry => ({
  stage_key: "build",
  session_role,
  launch_reason,
  template_path: `${session_role}-${launch_reason}.md`,
  content: `${session_role}:${launch_reason}`,
});

const prompts = Object.entries(BUILD_LAUNCH_REASONS).flatMap(([sessionRole, reasons]) =>
  reasons.map((reason) => prompt(sessionRole as "build" | "assessment", reason)));

const machine = createBuildCohortMachine({
  required_build_set: ["pr_summary", "build_result"],
  prompts,
});

if (!machine.ok) throw new Error(machine.error);

const state = (phase: BuildCohortPhase, overrides: Partial<BuildCohortState> = {}): BuildCohortState => ({
  ...initialBuildCohortState(["pr_summary", "build_result"]),
  phase,
  accepted_revision: phase === "builder_active" || phase === "pending" ? null : "revision-1",
  accepted_build_set: phase === "builder_active" || phase === "pending" ? [] : ["pr_summary", "build_result"],
  verified_pull_request: phase === "builder_active" || phase === "pending" ? null : { url: "https://example.test/pull/7", revision: "revision-1" },
  assessment_artifact_id: phase === "assessment_review" || phase === "awaiting_merge" || phase === "complete" ? "assessment-1" : null,
  ...overrides,
});

const EVENTS = [
  "stage_started",
  "build_evidence_observed",
  "builder_attempt_lost",
  "build_review_approved",
  "build_review_revision_requested",
  "assessment_artifact_recorded",
  "assessment_outcome_observed",
  "assessor_attempt_lost",
  "assessment_review_approved",
  "assessment_review_revision_requested",
  "pull_request_mismatch",
  "replacement_pull_request_required",
  "pull_request_merged",
] as const satisfies readonly BuildCohortEvent["kind"][];

const event = (kind: BuildCohortEvent["kind"]): BuildCohortEvent => {
  if (kind === "build_evidence_observed") return { kind, revision: "revision-1", output_name: "build_result", pull_request_url: "https://example.test/pull/7", is_verified: true };
  if (kind === "assessment_artifact_recorded") return { kind, artifact_id: "assessment-1" };
  if (kind === "assessment_outcome_observed") return { kind, outcome: "fail" };
  if (kind === "pull_request_mismatch") return { kind, pull_request_url: "https://example.test/pull/7" };
  if (kind === "replacement_pull_request_required") return { kind, pull_request_url: "https://example.test/pull/8" };
  if (kind === "pull_request_merged") return { kind, pull_request_url: "https://example.test/pull/7" };
  return { kind };
};

/*
 * Reviewed build-cohort transition table. This is deliberately test data,
 * rather than expectations derived from the implementation. Every event that
 * can reach every phase has a cell; repeated and late facts are recorded-only.
 */
const TRANSITION_TABLE: Readonly<Record<BuildCohortPhase, Readonly<Record<BuildCohortEvent["kind"], BuildEventDisposition>>>> = {
  pending: {
    stage_started: "transitioned", build_evidence_observed: "recorded_only", builder_attempt_lost: "recorded_only",
    build_review_approved: "recorded_only", build_review_revision_requested: "recorded_only", assessment_artifact_recorded: "recorded_only",
    assessment_outcome_observed: "recorded_only", assessor_attempt_lost: "recorded_only", assessment_review_approved: "recorded_only",
    assessment_review_revision_requested: "recorded_only", pull_request_mismatch: "recorded_only",
    replacement_pull_request_required: "recorded_only", pull_request_merged: "recorded_only",
  },
  builder_active: {
    stage_started: "recorded_only", build_evidence_observed: "transitioned", builder_attempt_lost: "transitioned",
    build_review_approved: "recorded_only", build_review_revision_requested: "recorded_only", assessment_artifact_recorded: "recorded_only",
    assessment_outcome_observed: "recorded_only", assessor_attempt_lost: "recorded_only", assessment_review_approved: "recorded_only",
    assessment_review_revision_requested: "recorded_only", pull_request_mismatch: "transitioned",
    replacement_pull_request_required: "transitioned", pull_request_merged: "recorded_only",
  },
  build_review: {
    stage_started: "recorded_only", build_evidence_observed: "recorded_only", builder_attempt_lost: "recorded_only",
    build_review_approved: "transitioned", build_review_revision_requested: "transitioned", assessment_artifact_recorded: "recorded_only",
    assessment_outcome_observed: "recorded_only", assessor_attempt_lost: "recorded_only", assessment_review_approved: "recorded_only",
    assessment_review_revision_requested: "recorded_only", pull_request_mismatch: "transitioned",
    replacement_pull_request_required: "transitioned", pull_request_merged: "recorded_only",
  },
  assessor_active: {
    stage_started: "recorded_only", build_evidence_observed: "recorded_only", builder_attempt_lost: "recorded_only",
    build_review_approved: "recorded_only", build_review_revision_requested: "recorded_only", assessment_artifact_recorded: "transitioned",
    assessment_outcome_observed: "recorded_only", assessor_attempt_lost: "transitioned", assessment_review_approved: "recorded_only",
    assessment_review_revision_requested: "recorded_only", pull_request_mismatch: "transitioned",
    replacement_pull_request_required: "transitioned", pull_request_merged: "recorded_only",
  },
  assessment_review: {
    stage_started: "recorded_only", build_evidence_observed: "recorded_only", builder_attempt_lost: "recorded_only",
    build_review_approved: "recorded_only", build_review_revision_requested: "recorded_only", assessment_artifact_recorded: "recorded_only",
    assessment_outcome_observed: "recorded_only", assessor_attempt_lost: "recorded_only", assessment_review_approved: "transitioned",
    assessment_review_revision_requested: "transitioned", pull_request_mismatch: "transitioned",
    replacement_pull_request_required: "transitioned", pull_request_merged: "recorded_only",
  },
  awaiting_merge: {
    stage_started: "recorded_only", build_evidence_observed: "recorded_only", builder_attempt_lost: "recorded_only",
    build_review_approved: "recorded_only", build_review_revision_requested: "recorded_only", assessment_artifact_recorded: "recorded_only",
    assessment_outcome_observed: "recorded_only", assessor_attempt_lost: "recorded_only", assessment_review_approved: "recorded_only",
    assessment_review_revision_requested: "recorded_only", pull_request_mismatch: "transitioned",
    replacement_pull_request_required: "transitioned", pull_request_merged: "transitioned",
  },
  complete: Object.fromEntries(EVENTS.map((kind) => [kind, "recorded_only"])) as Record<BuildCohortEvent["kind"], BuildEventDisposition>,
};

describe("build cohort transition table", () => {
  for (const [phase, expectedByEvent] of Object.entries(TRANSITION_TABLE) as [BuildCohortPhase, (typeof TRANSITION_TABLE)[BuildCohortPhase]][]) {
    for (const kind of EVENTS) test(`${phase} + ${kind} -> ${expectedByEvent[kind]}`, () => {
      const current = phase === "builder_active" && kind === "build_evidence_observed"
        ? state(phase, { accepted_revision: "revision-1", accepted_build_set: ["pr_summary"] })
        : state(phase);
      expect(applyBuildCohortEvent(machine.value, current, event(kind)).disposition).toBe(expectedByEvent[kind]);
    });
  }
});

test("the adapter registers exactly the six builder and two assessor launch cells", () => {
  expect(BUILD_LAUNCH_REASONS).toEqual({
    build: ["initial_build", "revision_after_build_review", "revision_after_assessment", "pr_mismatch_correction", "retry_after_lost_attempt", "replacement_pr"],
    assessment: ["initial_assessment", "retry_after_lost_attempt"],
  });
  expect(machine.value.prompts.size).toBe(8);
  const registry = createDevFlowAdapterRegistry();
  expect(registry.launch_reasons_for("build")).toEqual(BUILD_LAUNCH_REASONS.build);
  expect(registry.launch_reasons_for("assessment")).toEqual(BUILD_LAUNCH_REASONS.assessment);
});

test("build review requires the full declared set at one revision and a matching verified PR", () => {
  expect(isBuildReviewReady({ required_build_set: ["pr_summary", "build_result"], accepted_revision: "r2",
    accepted_build_set: ["build_result"], verified_pull_request: { url: "https://example.test/pull/7", revision: "r2" } })).toBe(false);
  expect(isBuildReviewReady({ required_build_set: ["pr_summary", "build_result"], accepted_revision: "r2",
    accepted_build_set: ["pr_summary", "build_result"], verified_pull_request: { url: "https://example.test/pull/7", revision: "r1" } })).toBe(false);
  expect(isBuildReviewReady({ required_build_set: ["pr_summary", "build_result"], accepted_revision: "r2",
    accepted_build_set: ["pr_summary", "build_result"], verified_pull_request: { url: "https://example.test/pull/7", revision: "r2" } })).toBe(true);
});

test("an assessment outcome is recorded without routing the cohort", () => {
  const current = state("assessor_active");
  const result = applyBuildCohortEvent(machine.value, current, { kind: "assessment_outcome_observed", outcome: "fail" });
  expect(result).toMatchObject({ disposition: "recorded_only", state: { phase: "assessor_active" } });
  expect(result.launch).toBeNull();
});

test("revision after assessment commits the revision prompt and names the existing PR", () => {
  const result = applyBuildCohortEvent(machine.value, state("assessment_review"), { kind: "assessment_review_revision_requested" });
  expect(result.launch).toMatchObject({ session_role: "build", launch_reason: "revision_after_assessment",
    prompt: { content: "build:revision_after_assessment" } });
  expect(result.launch?.contract_block).toContain("Existing PR: https://example.test/pull/7");
});
