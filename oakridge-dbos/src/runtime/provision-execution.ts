import { randomUUID } from "node:crypto";
import { runExclusive } from "./keyed-mutex";
import type { GitCommandRunner, ProvisionOutcome } from "../domain/repository-provisioning";
import { provisionRepositoryRefs, provisionFailureFromAdapter } from "../domain/repository-provisioning";
import type { RepositoryPreparationInputs, ProvisionRetryInput } from "../domain/dev-flow-v15";
import { err, ok, type ArtifactId, type CohortId, type ExecutionId, type Result } from "../domain/primitives";
import { claimExecutionIntent, publishWorkerOutputIn, finishProvisionExecutionIn, interruptProvisionExecution } from "../storage/postgres-run-record";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

export interface ProvisionExecutionDependencies {
  readonly sql: TransactionalSqlExecutor;
  readonly git: GitCommandRunner;
  readonly now: () => string;
  readonly advance: (cohort_id: CohortId) => Promise<unknown>;
}
interface ProvisionIntentLocation { readonly cohort_id: CohortId; readonly worker: string }
interface ProvisionCommitError { readonly kind: "publication_fenced" | "operation_failed"; readonly detail: string }
class ProvisionCommitAbort extends Error {
  constructor(readonly reason: ProvisionCommitError) { super(reason.detail); }
}

/** Operations have a durable intent and outcome; they never enter session IO. */
export const dispatchProvisionExecution = async (dependencies: ProvisionExecutionDependencies, execution_id: ExecutionId):
  Promise<Result<void, ProvisionCommitError>> => {
  const { sql, git, now } = dependencies;
  const location = (await sql.query<ProvisionIntentLocation>(
    "SELECT cohort_id::text,worker FROM oakridge.execution_intent WHERE id=$1", [execution_id]))[0];
  if (!location || location.worker !== "provision") return err({ kind: "operation_failed", detail: "provision intent not found" });
  const claimed = await claimExecutionIntent(sql, execution_id);
  if (!claimed.ok) {
    // A committed outcome can be replayed after a crash before progression.
    await dependencies.advance(location.cohort_id);
    return ok(undefined);
  }
  const resolved = claimed.value.resolved_input as unknown as RepositoryPreparationInputs | ProvisionRetryInput;
  const input = "original" in resolved ? resolved.original : resolved;
  let provisioned: Awaited<ReturnType<typeof provisionRepositoryRefs>>;
  try { provisioned = await runExclusive(input.repository.path, () => provisionRepositoryRefs(input, git)); }
  catch (cause) {
    // No outcome is known: preserve the original inputs for an explicit retry.
    const at = now();
    await interruptProvisionExecution(sql, { intent: claimed.value, detail: String(cause), at });
    await dependencies.advance(location.cohort_id);
    return err({ kind: "operation_failed", detail: String(cause) });
  }
  try {
    await sql.transaction(async (tx) => {
      await tx.query("SELECT id FROM oakridge.stage_instance WHERE id=$1 FOR SHARE", [claimed.value.stage_instance_id]);
      await tx.query("SELECT id FROM oakridge.workflow_run WHERE id=$1 FOR SHARE", [claimed.value.run_id]);
      await tx.query("SELECT id FROM oakridge.cohort WHERE id=$1 FOR UPDATE", [location.cohort_id]);
      const authority = await tx.query<{ readonly id: string }>(
        `UPDATE oakridge.execution_intent intent SET status='dispatched'
         FROM oakridge.cohort_worker worker,oakridge.cohort cohort,oakridge.stage_instance stage,oakridge.workflow_run run
         WHERE intent.id=$1 AND intent.stop_requested_at IS NULL AND intent.status='dispatching'
           AND worker.cohort_id=intent.cohort_id AND worker.worker='provision' AND worker.active_execution_id=intent.id
           AND cohort.id=intent.cohort_id AND stage.id=cohort.stage_instance_id AND run.id=cohort.run_id
           AND stage.status='active' AND run.status='active' RETURNING intent.id`, [execution_id]);
      if (!authority[0]) throw new ProvisionCommitAbort({ kind: "publication_fenced", detail: "provision operation owner stopped" });
      let outcome: ProvisionOutcome;
      const at = now();
      if (provisioned.ok) {
        const published = await publishWorkerOutputIn(tx, { execution_id, artifact_id: randomUUID() as ArtifactId,
          output_name: "repository_refs", collection_key: null, artifact_type: "dev.repository_refs",
          body: provisioned.value as unknown as import("../domain/primitives").JsonValue, expected: null, at });
        if (!published.ok) throw new ProvisionCommitAbort({ kind: "publication_fenced", detail: published.error.detail });
        outcome = { kind: "succeeded", output: published.value };
      } else outcome = { kind: "failed", failure: provisionFailureFromAdapter({
        cohort_id: location.cohort_id, repository_key: input.repository.key, failure: provisioned.error }) };
      await finishProvisionExecutionIn(tx, { execution_id, cohort_id: location.cohort_id,
        attempt_id: claimed.value.attempt_id, outcome, at });
    });
  } catch (cause) {
    if (cause instanceof ProvisionCommitAbort) return err(cause.reason);
    throw cause;
  }
  await dependencies.advance(location.cohort_id);
  return ok(undefined);
};
