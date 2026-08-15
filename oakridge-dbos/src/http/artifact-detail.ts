import { Hono } from "hono";

import type { OperatorArtifactDetail, OperatorArtifactRevision } from "../domain/operator-projections";
import type { ArtifactTypeDefinition } from "../domain/artifact-types";
import type { ArtifactId } from "../domain/primitives";
import type { ArtifactRevisionRepository, GateDecisionAuditRepository, StageInstanceRepository } from "../storage/repositories";

export interface ArtifactTypePresentation {
  readonly component_id: string;
  readonly capabilities: NonNullable<OperatorArtifactDetail["capabilities"]>;
  readonly anchor_schema: readonly string[] | null;
  readonly review: OperatorArtifactDetail["review"];
}
export interface ArtifactDetailDependencies {
  readonly artifacts: ArtifactRevisionRepository;
  readonly stages: StageInstanceRepository;
  readonly audits: GateDecisionAuditRepository;
  readonly presentation_for_type: (artifact_type: string) => ArtifactTypePresentation | null;
  readonly artifact_types?: readonly ArtifactTypeDefinition[];
}

const passActions = new Set(["pass", "approve", "confirm_merged", "closed_without_merge"]);

export const createArtifactDetailApp = (dependencies: ArtifactDetailDependencies): Hono => {
  const app = new Hono();
  app.get("/artifact_types", (http) => http.json(dependencies.artifact_types ?? []));
  app.get("/artifact_details/:id", async (http) => {
    const requested = await dependencies.artifacts.find_by_id(http.req.param("id") as ArtifactId);
    if (!requested) return http.json({ error: "artifact not found" }, 404);
    const stage = await dependencies.stages.find_by_id(requested.stage_instance_id);
    if (!stage) return http.json({ error: "producing stage not found" }, 404);
    const chain = await dependencies.artifacts.list_chain(requested.chain_id);
    const revisions: OperatorArtifactRevision[] = [];
    for (const revision of chain) {
      const decision = await dependencies.audits.find_for_revision(revision.id);
      const status: OperatorArtifactRevision["status"] = !decision ? "draft" : passActions.has(decision.action) ? "approved" : "rejected";
      revisions.push({ id: revision.id, status, lifecycle: revision.lifecycle.kind, created_at: revision.created_at, body: revision.body, validation: {} });
    }
    const presentation = dependencies.presentation_for_type(requested.artifact_type);
    const detail: OperatorArtifactDetail = {
      id: requested.id, requested_revision_id: requested.id,
      current_revision_id: chain.find((revision) => revision.lifecycle.kind === "current")?.id ?? null,
      type_id: requested.artifact_type, component_id: presentation?.component_id ?? null,
      capabilities: presentation?.capabilities ?? null, anchor_schema: presentation?.anchor_schema ?? null, review: presentation?.review ?? null,
      run_id: requested.run_id, producing_stage: stage.stage_key, label: requested.label, revisions,
    };
    return http.json(detail);
  });
  return app;
};
