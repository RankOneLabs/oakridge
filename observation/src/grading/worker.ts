import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import type { GradeRunner } from "../ports/grade-runner";
import type { Database, TenantScope } from "../storage/database";
import { claimNext, completeExecution, failExecution, markRequestSent, readExecutionContext, requeueAllDeferred,
  type ExecutionContext } from "../storage/execution-store";
import type { GradingControls } from "./budget";
import type { EvaluatorDefinition } from "./evaluator";
import { answerProblem, type AttemptFailure, type ClaimResult, type ExecutionClaim, type SettlementResult } from "./execution";
import { runnerEntry, type RunnerResult } from "./runner";

/**
 * The grading worker: claim one due execution, call its pinned runner with no transaction open,
 * then settle under the exact claim. Grades and provider failures stay in observation: nothing
 * here can write to Oakridge or decide a workflow.
 */
export type RunnerResolver = (evaluator: EvaluatorDefinition) => GradeRunner | null;

/** Builds each pinned definition's runner from the retained registry, once per runner name. */
export function registryRunners(controls: Pick<GradingControls, "provider_deadline_ms">, env: NodeJS.ProcessEnv): RunnerResolver {
  const built = new Map<string, GradeRunner>();
  return (evaluator) => {
    if (evaluator.kind === "human") return null;
    const known = built.get(evaluator.backend_kind);
    if (known) return known;
    const entry = runnerEntry(evaluator.backend_kind);
    if (!entry) return null;
    const runner = entry.factory(controls.provider_deadline_ms, env);
    built.set(evaluator.backend_kind, runner);
    return runner;
  };
}

export type LogDecision = (message: string, detail: Readonly<Record<string, unknown>>) => void;
export interface GradingWorkerDependencies {
  readonly db: Database;
  readonly tenants: readonly TenantScope[];
  readonly controls: GradingControls;
  readonly runners: RunnerResolver;
  /** This worker's lease identity; distinct per process. */
  readonly lease_owner?: string;
  readonly log?: LogDecision;
  /** How long an idle worker waits before looking again. */
  readonly idle_ms?: number;
}

/** One pass of the worker for one tenant. */
export type WorkOutcome =
  | Exclude<ClaimResult, { readonly kind: "claimed" }>
  | { readonly kind: "settled"; readonly claim: ExecutionClaim; readonly result: SettlementResult }
  | { readonly kind: "settlement_error"; readonly claim: ExecutionClaim; readonly detail: string };

const defaultLog: LogDecision = (message, detail) => console.info(`[observation] ${message}`, detail);
export const workerIdentity = (): string => `${hostname()}:${process.pid}:${randomUUID()}`;

function runnerFailure(result: Extract<RunnerResult, { ok: false }>): AttemptFailure {
  return { category: result.error.category ?? "runner_error", detail: result.error.detail,
    provider_request_id: result.error.external_execution_id ?? null, provider_cost: result.error.cost ?? null };
}

async function measure(context: ExecutionContext, runner: GradeRunner | null, onRequest: () => Promise<boolean>): Promise<RunnerResult> {
  if (!runner) return { ok: false, error: { operation: "grading_worker", entity_id: context.evaluator.evaluator_definition_id,
    detail: `no retained runner for ${context.evaluator.backend_kind}`, category: "invalid_request" } };
  try { return await runner.run({ question: context.question, evaluator: context.evaluator, evidence: context.evidence }, onRequest); }
  catch (cause) {
    return { ok: false, error: { operation: "grading_worker", entity_id: context.evaluator.evaluator_definition_id,
      detail: cause instanceof Error ? cause.message : String(cause), category: "transport" } };
  }
}

/** Claim, measure and settle one execution of one tenant. */
export async function gradeNext(deps: GradingWorkerDependencies & { readonly lease_owner: string }, tenant: TenantScope): Promise<WorkOutcome> {
  const log = deps.log ?? defaultLog;
  const claimed = await claimNext(deps.db, tenant, { lease_owner: deps.lease_owner, lease_ms: deps.controls.lease_ms,
    run_spend: deps.controls.run_spend });
  if (claimed.kind !== "claimed") {
    if (claimed.kind !== "idle") log(`grading ${claimed.kind}`, { namespace: tenant.namespace, run_id: claimed.run_id, execution_id: claimed.execution_id });
    return claimed;
  }
  const claim = claimed.claim;
  const context = await readExecutionContext(deps.db, tenant, claim.execution_id);
  const settle = async (): Promise<WorkOutcome> => {
    if (!context.ok) return settled(await failExecution(deps.db, tenant, claim, { category: "invalid_request", detail: context.error.detail,
      provider_request_id: null, provider_cost: null }));
    // The claim transaction has committed: the provider request runs with no transaction open.
    const result = await measure(context.value, deps.runners(context.value.evaluator), () => markRequestSent(deps.db, tenant, claim));
    if (!result.ok) return settled(await failExecution(deps.db, tenant, claim, runnerFailure(result)));
    const problem = answerProblem(context.value.question, result.value.answer);
    if (problem) return settled(await failExecution(deps.db, tenant, claim, { category: "invalid_answer", detail: problem,
      provider_request_id: result.value.external_execution_id ?? null, provider_cost: result.value.cost ?? null }));
    const completed = await completeExecution(deps.db, tenant, claim, result.value);
    if (completed.ok) return settled(completed);
    return settled(await failExecution(deps.db, tenant, claim, { category: "settlement_failed", detail: completed.error.detail,
      provider_request_id: result.value.external_execution_id ?? null, provider_cost: result.value.cost ?? null }));
  };
  const settled = (result: Awaited<ReturnType<typeof failExecution>>): WorkOutcome => result.ok
    ? { kind: "settled", claim, result: result.value } : { kind: "settlement_error", claim, detail: result.error.detail };
  const outcome = await settle();
  log("grading settled", { namespace: tenant.namespace, run_id: claim.run_id, execution_id: claim.execution_id, claim_attempt: claim.claim_attempt,
    ...(outcome.kind === "settled" ? { result: outcome.result.kind } : outcome.kind === "settlement_error" ? { error: outcome.detail } : {}) });
  return outcome;
}

export interface GradingWorker { stop(): Promise<void> }

/** Runs until stopped. Each tenant is offered work in turn; an idle round waits before the next. */
export function startGradingWorker(deps: GradingWorkerDependencies): GradingWorker {
  const controller = new AbortController();
  const lease_owner = deps.lease_owner ?? workerIdentity();
  const log = deps.log ?? defaultLog;
  const wait = (): Promise<void> => new Promise((resolve) => {
    const timer = setTimeout(done, deps.idle_ms ?? 1_000);
    function done(): void { controller.signal.removeEventListener("abort", abort); resolve(); }
    function abort(): void { clearTimeout(timer); done(); }
    controller.signal.addEventListener("abort", abort, { once: true });
  });
  const running = (async () => {
    for (const tenant of deps.tenants) await requeueAllDeferred(deps.db, tenant)
      .catch((error: unknown) => log("grading deferral requeue failed", { namespace: tenant.namespace, error: String(error) }));
    while (!controller.signal.aborted) {
      let worked = false;
      for (const tenant of deps.tenants) {
        if (controller.signal.aborted) break;
        try {
          const outcome = await gradeNext({ ...deps, lease_owner, log }, tenant);
          if (outcome.kind !== "idle") worked = true;
        } catch (error) { log("grading worker pass failed", { namespace: tenant.namespace, error: String(error) }); }
      }
      if (!worked) await wait();
    }
  })();
  return { async stop() { controller.abort(); await running; } };
}
