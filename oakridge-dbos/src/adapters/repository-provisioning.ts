import type { ExecutionRequest, ExecutorAdapter, ExecutorObservationAttempt, ExecutorTerminalObservation, ExternalExecutionReference } from "../domain/execution";
import type { ExecutionId, JsonValue, Result, WorkOrderId } from "../domain/primitives";
import type { PublishWorkOrderArtifactResult } from "../domain/run-record";
import { describeRepositoryProvisioningFailure, provisionRepositoryRefs, type GitCommandRunner } from "../domain/repository-provisioning";
import { PROVISION_REPOSITORY_REFS_STAGE_TYPE, parseResolvedRepositoryProvisioningConfig } from "../domain/repository-refs";
import type { EmitExecutionArtifactFailure, EmitExecutionArtifactRequest, EmittedExecutionArtifact } from "../runtime/emit-artifact";
import { runExclusive } from "../runtime/keyed-mutex";

const failed = (code: string, detail: string): ExecutorTerminalObservation => ({ kind: "failed", code, detail });

export interface RepositoryProvisioningAdapterDependencies {
  readonly git: GitCommandRunner;
  emit(request: EmitExecutionArtifactRequest): Promise<Result<EmittedExecutionArtifact, EmitExecutionArtifactFailure>>;
  publish_work_order?(request: { readonly work_order_id: WorkOrderId; readonly capability: string; readonly output_name: string; readonly body: JsonValue; readonly idempotency_key: string }): Promise<PublishWorkOrderArtifactResult>;
}

/**
 * The deterministic executor behind the `provision_repository_refs` stage.
 *
 * It guarantees, per repository, that the epic branch a run's cohorts will
 * branch from and target actually exists — and emits what it guaranteed as a
 * typed artifact the build stage declares as an input. Nothing did this in v2:
 * the branch was named, validated and consumed, and created by nobody.
 *
 * The work happens in `start_or_attach` and its outcome travels back in a
 * `completed` reference, so the adapter itself holds no state. That matters
 * more here than it looks: `observe_terminal` is handed only an execution id
 * and that reference, and a rerun forks the execution workflow from step zero —
 * so an adapter remembering outcomes in a map would answer correctly right up
 * until the moment anything went wrong.
 *
 * Failures come back as terminal observations rather than thrown errors, for
 * the same reason the kbbl adapter reports them that way: this is the only path
 * by which the unit can ever be reported terminal, and an exception inside the
 * retrying step that carries it leaves the execution waiting on a message that
 * can no longer arrive.
 */
export class RepositoryProvisioningAdapter implements ExecutorAdapter {
  readonly executor_type = PROVISION_REPOSITORY_REFS_STAGE_TYPE;

  constructor(private readonly dependencies: RepositoryProvisioningAdapterDependencies) {}

  async start_or_attach(request: ExecutionRequest, _attempt_id: string): Promise<ExternalExecutionReference> {
    return { kind: "completed", observation: await this.provision(request) };
  }

  async observe_terminal(execution_id: ExecutionId, external_reference: ExternalExecutionReference): Promise<ExecutorObservationAttempt> {
    if (external_reference.kind !== "completed") {
      return { kind: "terminal", observation: failed("provisioning_not_started", `execution ${execution_id} has no completed provisioning reference`) };
    }
    return { kind: "terminal", observation: external_reference.observation };
  }

  async deliver_input(): Promise<void> {
    // Nothing consumes input here: there is no session to talk to, and revising
    // provisioned refs is a rerun rather than a conversation.
  }

  async cancel_or_fence(): Promise<void> {
    // Nothing to fence. Every command is a short-lived subprocess that has
    // already exited by the time the reference exists.
  }

  private async provision(request: ExecutionRequest): Promise<ExecutorTerminalObservation> {
    try {
      const config = parseResolvedRepositoryProvisioningConfig(request.resolved_config);
      if (!config.ok) return failed("invalid_resolved_config", config.error.detail);
      const repository = config.value.repository;
      // Serialized per working copy: two runs seeding base branches in the same
      // repository otherwise race `git fetch`, and the loser dies on "cannot
      // lock ref ... unable to update local ref". Distinct repositories, and so
      // distinct keys, still run in parallel.
      const provisioned = await runExclusive(repository.path, () =>
        provisionRepositoryRefs({ repository, base_branch: config.value.base_branch }, this.dependencies.git));
      if (!provisioned.ok) return failed(provisioned.error.kind, describeRepositoryProvisioningFailure(provisioned.error));
      if (config.value.publication) {
        if (!this.dependencies.publish_work_order) return failed("v2_publication_unavailable", "work-order publication is not configured");
        const published = await this.dependencies.publish_work_order({ work_order_id: config.value.publication.work_order_id as WorkOrderId,
          capability: config.value.publication.capability, output_name: config.value.output_name, body: { ...provisioned.value },
          idempotency_key: `${request.execution_id}:${config.value.output_name}` });
        if (published.kind !== "published" && published.kind !== "pending" && published.kind !== "already_applied") {
          return failed(`emit_${published.kind}`, published.detail);
        }
        return { kind: "succeeded", metadata: { base_branch: provisioned.value.base_branch, base_head_sha: provisioned.value.base_head_sha } satisfies JsonValue };
      }
      const emitted = await this.dependencies.emit({
        stage_instance_id: request.stage_instance_id,
        unit_id: request.unit_id,
        executor_type: this.executor_type,
        output_name: config.value.output_name,
        body: { ...provisioned.value },
        // Keyed on the execution and output rather than the payload: the base
        // branch head moves as build units merge into it, so a replay of this
        // unit is still one output and must not open a second revision chain.
        idempotency_key: `${request.execution_id}:${config.value.output_name}`,
      });
      if (!emitted.ok) return failed(`emit_${emitted.error.kind}`, emitted.error.detail);
      return { kind: "succeeded", metadata: { base_branch: provisioned.value.base_branch, base_head_sha: provisioned.value.base_head_sha } satisfies JsonValue };
    } catch (error) {
      // The IO boundary. Whatever the git runner or the emitter threw becomes
      // this unit's outcome rather than the observer's death.
      return failed("provisioning_error", error instanceof Error ? error.message : String(error));
    }
  }
}
