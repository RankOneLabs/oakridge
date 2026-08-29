import { Hono } from "hono";

import { createArtifactCallbackApp, type ArtifactCallbackDependencies } from "./artifact-callback";
import { createArtifactWithdrawApp, type ArtifactWithdrawDependencies } from "./artifact-withdraw";
import { createGateResumeApp, type GateResumeDependencies } from "./gate-resume";
import { createHandoffCompleteApp, type HandoffCompleteDependencies } from "./handoff-complete";
import { createCohortPullRequestApp, type CohortPullRequestHttpDependencies } from "./cohort-pull-request";
import { createCollaborationApp, type CollaborationHttpDependencies } from "./collaboration";
import { createOperatorProjectionApp } from "./operator-projections";
import type { OperatorProjectionRepository } from "../storage/postgres-operators";
import { createArtifactDetailApp, type ArtifactDetailDependencies } from "./artifact-detail";
import { createInvalidationEventApp } from "./invalidation-events";
import { createRerunApp, type RerunHttpDependencies } from "./rerun";
import { createRunLaunchApp } from "./run-launch";
import type { LaunchRunDependencies } from "../runtime/launch-run";
import { createConfigurationApp, type ConfigurationHttpDependencies } from "./configuration";
import { createAdmissionApp, type AdmissionHttpDependencies } from "./admission";
import { createRunLifecycleApp, type RunLifecycleHttpDependencies } from "./run-lifecycle";
import { createDomainReadApp, type DomainReadHttpDependencies } from "./domain-reads";
import { createFinalPullRequestApp, type FinalPullRequestHttpDependencies } from "./final-pull-request";
import { controlTokenMiddleware } from "./control-auth";
import { sharedCursor } from "./shared-cursor";
import { createWorkOrderArtifactCallbackApp, type WorkOrderArtifactCallbackDependencies } from "./work-order-artifact-callback";
import { createOperatorRetryApp, type OperatorRetryHttpDependencies } from "./operator-retry";

export interface OakridgeHttpDependencies {
  readonly configuration: ConfigurationHttpDependencies;
  readonly admission: AdmissionHttpDependencies;
  readonly operator_retry: OperatorRetryHttpDependencies;
  readonly run_lifecycle: RunLifecycleHttpDependencies;
  readonly domain_reads: DomainReadHttpDependencies;
  readonly final_pull_requests: FinalPullRequestHttpDependencies;
  readonly artifact_callback: ArtifactCallbackDependencies;
  readonly work_order_artifact_callback: WorkOrderArtifactCallbackDependencies;
  readonly artifact_withdraw: ArtifactWithdrawDependencies;
  readonly gate_resume: GateResumeDependencies;
  readonly handoff_complete: HandoffCompleteDependencies;
  readonly cohort_pull_requests: CohortPullRequestHttpDependencies;
  readonly collaboration: CollaborationHttpDependencies;
  readonly operator_projections: OperatorProjectionRepository;
  readonly artifact_detail: ArtifactDetailDependencies;
  readonly rerun: RerunHttpDependencies;
  readonly run_launch: LaunchRunDependencies;
  /** Bearer token required on state-changing requests; absent on a loopback bind. */
  readonly control_token?: string;
}

export const createApp = (dependencies: OakridgeHttpDependencies): Hono => {
  const app = new Hono();
  if (dependencies.control_token) app.use("*", controlTokenMiddleware(dependencies.control_token));
  app.route("/", createConfigurationApp(dependencies.configuration));
  app.route("/", createAdmissionApp(dependencies.admission));
  app.route("/", createOperatorRetryApp(dependencies.operator_retry));
  app.route("/", createRunLifecycleApp(dependencies.run_lifecycle));
  app.route("/", createDomainReadApp(dependencies.domain_reads));
  app.route("/", createFinalPullRequestApp(dependencies.final_pull_requests));
  app.route("/", createArtifactCallbackApp(dependencies.artifact_callback));
  app.route("/", createWorkOrderArtifactCallbackApp(dependencies.work_order_artifact_callback));
  app.route("/", createArtifactWithdrawApp(dependencies.artifact_withdraw));
  app.route("/", createGateResumeApp(dependencies.gate_resume));
  app.route("/", createHandoffCompleteApp(dependencies.handoff_complete));
  app.route("/", createCohortPullRequestApp(dependencies.cohort_pull_requests));
  app.route("/", createCollaborationApp(dependencies.collaboration));
  app.route("/", createOperatorProjectionApp(dependencies.operator_projections));
  app.route("/", createArtifactDetailApp(dependencies.artifact_detail));
  app.route("/", createInvalidationEventApp({ current_cursor: sharedCursor(() => dependencies.operator_projections.get_invalidation_cursor()) }));
  app.route("/", createRerunApp(dependencies.rerun));
  app.route("/", createRunLaunchApp(dependencies.run_launch));
  return app;
};
