import { Hono } from "hono";

import type { WorkflowDefinitionRepository } from "../storage/repositories";
import { createArtifactCallbackApp, type ArtifactCallbackDependencies } from "./artifact-callback";
import { createArtifactWithdrawApp, type ArtifactWithdrawDependencies } from "./artifact-withdraw";
import { createGateResumeApp, type GateResumeDependencies } from "./gate-resume";
import { createHandoffCompleteApp, type HandoffCompleteDependencies } from "./handoff-complete";
import { createCollaborationApp, type CollaborationHttpDependencies } from "./collaboration";
import { createOperatorProjectionApp } from "./operator-projections";
import type { OperatorProjectionRepository } from "../storage/postgres-operators";
import { createArtifactDetailApp, type ArtifactDetailDependencies } from "./artifact-detail";
import { createInvalidationEventApp } from "./invalidation-events";
import { createRerunApp, type RerunHttpDependencies } from "./rerun";
import { createRunLaunchApp } from "./run-launch";
import type { LaunchRunDependencies } from "../runtime/launch-run";

export interface OakridgeHttpDependencies {
  readonly definitions: WorkflowDefinitionRepository;
  readonly artifact_callback: ArtifactCallbackDependencies;
  readonly artifact_withdraw: ArtifactWithdrawDependencies;
  readonly gate_resume: GateResumeDependencies;
  readonly handoff_complete: HandoffCompleteDependencies;
  readonly collaboration: CollaborationHttpDependencies;
  readonly operator_projections: OperatorProjectionRepository;
  readonly artifact_detail: ArtifactDetailDependencies;
  readonly rerun: RerunHttpDependencies;
  readonly run_launch: LaunchRunDependencies;
}

export const createApp = (dependencies: OakridgeHttpDependencies): Hono => {
  const app = new Hono();
  app.get("/workflow_defs", async (context) => context.json(await dependencies.definitions.list()));
  app.get("/workflow_defs/:id", async (context) => {
    const definition = await dependencies.definitions.find_by_id(context.req.param("id") as Parameters<WorkflowDefinitionRepository["find_by_id"]>[0]);
    return definition ? context.json(definition) : context.json({ error: "workflow definition not found" }, 404);
  });
  app.route("/", createArtifactCallbackApp(dependencies.artifact_callback));
  app.route("/", createArtifactWithdrawApp(dependencies.artifact_withdraw));
  app.route("/", createGateResumeApp(dependencies.gate_resume));
  app.route("/", createHandoffCompleteApp(dependencies.handoff_complete));
  app.route("/", createCollaborationApp(dependencies.collaboration));
  app.route("/", createOperatorProjectionApp(dependencies.operator_projections));
  app.route("/", createArtifactDetailApp(dependencies.artifact_detail));
  app.route("/", createInvalidationEventApp({ current_cursor: () => dependencies.operator_projections.get_invalidation_cursor() }));
  app.route("/", createRerunApp(dependencies.rerun));
  app.route("/", createRunLaunchApp(dependencies.run_launch));
  return app;
};
