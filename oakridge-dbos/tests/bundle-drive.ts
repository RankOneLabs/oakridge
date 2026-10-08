/**
 * The stage sequence of a shipped development bundle, driven through the
 * production composition.
 *
 * Each `drive*` transform takes the harness plus the scope it acts on and
 * returns when that stage's scope is terminal. A session stage is driven the
 * way a real agent drives it: the session is started by the run loop, the
 * agent publishes its declared outputs through the token-authenticated
 * execution route, and only then does the session exit.
 */
import type { Harness, HarnessScope } from "./bundle-harness";
import { eventually, pullRequestUrl, revisionOf } from "./bundle-harness";

export interface CohortBrief {
  readonly cohort_id: string;
  readonly repository_key: string;
  readonly depends_on: readonly string[];
}

export const briefBody = (brief: CohortBrief) => ({
  cohort_id: brief.cohort_id, repository_key: brief.repository_key, title: `Build ${brief.cohort_id}`,
  depends_on: [...brief.depends_on], goal: "Feature", files_in_scope: ["src"], decisions_made: [],
  approaches_rejected: [], acceptance_criteria: ["tests pass"], next_action: "Implement",
});

export const analysisBody = {
  summary: "Spec", source_spec_refs: [], findings: [], requirements: [], risks: [],
};

export const planBody = (briefs: readonly CohortBrief[]) => ({
  summary: "Plan",
  cohorts: briefs.map((brief) => ({ id: brief.cohort_id, repository_key: brief.repository_key,
    title: `Build ${brief.cohort_id}`, scope: "Feature", depends_on: [...brief.depends_on], description: null,
    files_in_scope: ["src"], decisions: [], acceptance_criteria: ["tests pass"] })),
  dependency_order: briefs.map((brief) => brief.cohort_id),
  scope: { in_scope: [], out_of_scope: [] }, acceptance_criteria: [], risks: [],
});

export const buildBody = (brief: CohortBrief) => ({
  repository_key: brief.repository_key, summary: "Built", changed_files: ["src"],
  tests: { passed: 1, failed: 0, output: null, summary: null, cargo_test_output: null },
  delegated_session_metadata: { cohort_id: brief.cohort_id, session_id: null, branch: "work" },
  known_issues: [],
});

/** Each scope gets its own branch, so sibling cohorts own separate pull requests. */
export const prBody = (branch: string) => ({
  pr_url: pullRequestUrl(branch), branch, summary: "Feature", review_status: null,
});

export const assessmentBody = {
  verdict: "pass", findings: [], test_evidence: null, recommended_next_actions: [],
};

/**
 * Children auto-begin from their declared `entry_command`; nothing is
 * commanded here. The list is re-read each poll because a bundle can declare
 * more than one preparation child and they materialize independently.
 */
export async function drivePreparations(h: Harness): Promise<void> {
  await eventually(async () => {
    const found = await h.children("repository_preparation");
    return found.length > 0 && found.every((scope) => scope.is_terminal) ? true : null;
  }, "every repository preparation child terminal", 60_000);
}

/** A single-output review stage: publish, exit, accept. */
async function driveReviewStage(h: Harness, scope: HarnessScope, output_key: string, body: unknown): Promise<void> {
  await h.awaitSession(scope.id, "author");
  const revision_id = await h.publish(scope.id, "author", output_key, body);
  await h.awaitState(scope.id, "review");
  h.settle(scope.id, "author");
  await h.awaitTerminalExecution(scope.id);
  await h.requireCommand(scope.id, "accept", { revision: revisionOf(revision_id) });
  await h.awaitTerminalScope(scope.id);
}

export async function driveAnalysis(h: Harness): Promise<HarnessScope> {
  const analysis = await h.awaitChild("spec_analysis");
  await driveReviewStage(h, analysis, "analysis", analysisBody);
  return analysis;
}

export async function drivePlanning(h: Harness, briefs: readonly CohortBrief[]): Promise<HarnessScope> {
  const planning = await h.awaitChild("planning");
  await driveReviewStage(h, planning, "plan", planBody(briefs));
  return planning;
}

export async function driveBriefWriting(h: Harness, briefs: readonly CohortBrief[]): Promise<HarnessScope> {
  const writing = await h.awaitChild("brief_writing");
  await h.awaitSession(writing.id, "author");
  // Collection members are accepted in key order, as the authority stores them.
  const ordered = [...briefs].sort((left, right) => left.cohort_id.localeCompare(right.cohort_id));
  const revisions: ReturnType<typeof revisionOf>[] = [];
  for (const brief of ordered) {
    revisions.push(revisionOf(await h.publish(writing.id, "author", "briefs", briefBody(brief), brief.cohort_id)));
  }
  await h.awaitState(writing.id, "review");
  h.settle(writing.id, "author");
  await h.awaitTerminalExecution(writing.id);
  await h.requireCommand(writing.id, "accept", { revisions, briefs: ordered.map(briefBody) });
  await h.awaitTerminalScope(writing.id);
  return writing;
}

/**
 * The implementation stage: build session, pull-request observation, build
 * acceptance, assessment session, assessment acceptance, merge confirmation.
 */
export async function driveImplementation(h: Harness, scope: HarnessScope, brief: CohortBrief): Promise<void> {
  const branch = `work-${brief.cohort_id}`;
  await h.awaitSession(scope.id, "build");
  const build_revision = await h.publish(scope.id, "build", "build_result", buildBody(brief));
  const pr_revision = await h.publish(scope.id, "build", "pr_summary", prBody(branch));
  h.settle(scope.id, "build");
  const target = { build_result: revisionOf(build_revision), pr_summary: revisionOf(pr_revision),
    pr_url: pullRequestUrl(branch), head_sha: "head1" };
  await h.requireCommand(scope.id, "accept_build", target);

  await h.awaitSession(scope.id, "assessment");
  const assessment_revision = await h.publish(scope.id, "assessment", "assessment", assessmentBody);
  h.settle(scope.id, "assessment");
  await h.requireCommand(scope.id, "accept_assessment", { ...target, assessment: revisionOf(assessment_revision) });

  h.pull_requests.merge(branch);
  await h.requireCommand(scope.id, "refresh_pr", {});
  await h.requireCommand(scope.id, "confirm_merged", {});
  await h.awaitTerminalScope(scope.id);
}

export async function driveIntegration(h: Harness, scope: HarnessScope): Promise<void> {
  const branch = `work-integration-${scope.child_key}`;
  await h.awaitSession(scope.id, "integrator");
  const revision_id = await h.publish(scope.id, "integrator", "pr_summary", prBody(branch));
  h.settle(scope.id, "integrator");
  const target = { revision: revisionOf(revision_id), pr_url: pullRequestUrl(branch), head_sha: "head1" };
  await h.requireCommand(scope.id, "review_pr", target);
  h.pull_requests.merge(branch);
  await h.requireCommand(scope.id, "refresh_pr", {});
  await h.requireCommand(scope.id, "confirm_merged", target);
  await h.awaitTerminalScope(scope.id);
}
