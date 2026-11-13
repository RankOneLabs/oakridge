import type { RuntimeConfiguration } from "../grading/runtime-configuration";
import type { RunAdmission } from "../grading/execution";
import type { RepositoryReader } from "../ports/artifact-source";
import type { EvidenceCollector } from "../ports/producer-profile";
import { CaptureArtifactSource } from "./capture-artifact-source";
import { collectWaitingEvidence, readWaitingRuns, type RunCollection } from "./captured-evidence-store";
import type { Database, TenantScope } from "./database";
import { admitRun, readRunsAwaitingAdmission, type AdmissionControls } from "./execution-store";

/** One reconciliation of a run: its waiting questions collected, then its ready questions admitted. */
export interface RunReconciliation {
  readonly collection: RunCollection;
  /** Null when no admission is composed, or when admission failed (see `admission_error`). */
  readonly admission: RunAdmission | null;
  readonly admission_error: string | null;
}

/**
 * The one server-side reconciler. It collects evidence for every captured question whether or not
 * automatic grading is on, so reviewers always have it, and admits ready questions only for runs
 * whose launch turned grading on. It reads captured copies and the repositories they name; it calls
 * no provider. Browsers, item selection, approvals, tasks and links play no part.
 */
export interface EvidenceReconciler {
  /** One pass over a run. Passes for the same run never overlap, and a request made during a pass
   * gets a fresh pass after it, so input that arrived meanwhile is seen. */
  reconcileRun(tenant: TenantScope, run_id: string): Promise<RunReconciliation>;
  /** Every run with a waiting question or ready questions still to admit, as at startup. */
  reconcileAll(tenant: TenantScope): Promise<readonly RunReconciliation[]>;
}
interface EvidenceReconcilerBase {
  readonly db: Database;
  readonly repository: RepositoryReader;
  /** Absent means evidence is collected and nothing is admitted. */
  readonly admission?: AdmissionControls;
  readonly log?: (message: string, detail: Readonly<Record<string, unknown>>) => void;
}

export type EvidenceReconcilerDependencies = EvidenceReconcilerBase & (
  | { readonly runtime_configuration: RuntimeConfiguration; readonly collector?: never }
  | { readonly collector: EvidenceCollector; readonly runtime_configuration?: never }
);

const defaultLog = (message: string, detail: Readonly<Record<string, unknown>>): void => console.info(`[observation] ${message}`, detail);
export function createEvidenceReconciler(deps: EvidenceReconcilerDependencies): EvidenceReconciler {
  const log = deps.log ?? defaultLog;
  const running = new Map<string, Promise<RunReconciliation>>();
  const queued = new Map<string, Promise<RunReconciliation>>();
  const pass = async (tenant: TenantScope, run_id: string): Promise<RunReconciliation> => {
    const source = new CaptureArtifactSource({ db: deps.db, tenant, run_id, collector: deps.runtime_configuration ? deps.runtime_configuration.current().profile.evidence : deps.collector, repository: deps.repository });
    const collection = await collectWaitingEvidence(deps.db, tenant, source, run_id);
    if (collection.ready.length + collection.waiting.length + collection.failed.length > 0)
      log("evidence collected", { producer: tenant.producer, namespace: tenant.namespace, run_id, ready: collection.ready.length,
        waiting: collection.waiting.map((entry) => entry.code), failed: collection.failed.map((entry) => entry.detail) });
    if (!deps.admission) return { collection, admission: null, admission_error: null };
    const admitted = await admitRun(deps.db, tenant, run_id, deps.admission);
    if (!admitted.ok) {
      log("admission failed", { producer: tenant.producer, namespace: tenant.namespace, run_id, detail: admitted.error.detail });
      return { collection, admission: null, admission_error: admitted.error.detail };
    }
    if (admitted.value.kind === "admitted" && admitted.value.admitted.length > 0)
      log("executions admitted", { producer: tenant.producer, namespace: tenant.namespace, run_id, admitted: admitted.value.admitted.length });
    return { collection, admission: admitted.value, admission_error: null };
  };
  const reconcileRun = (tenant: TenantScope, run_id: string): Promise<RunReconciliation> => {
    const key = JSON.stringify([tenant.producer, tenant.namespace, run_id]);
    const behind = queued.get(key);
    if (behind) return behind;
    const current = running.get(key);
    const start = (): Promise<RunReconciliation> => {
      const next = pass(tenant, run_id).finally(() => { if (running.get(key) === next) running.delete(key); });
      running.set(key, next);
      return next;
    };
    if (!current) return start();
    const after = current.catch(() => undefined).then(() => { queued.delete(key); return start(); });
    queued.set(key, after);
    return after;
  };
  return {
    reconcileRun,
    async reconcileAll(tenant) {
      const waiting = await readWaitingRuns(deps.db, tenant);
      const awaiting = deps.admission ? await readRunsAwaitingAdmission(deps.db, tenant) : [];
      const reconciled: RunReconciliation[] = [];
      for (const run_id of [...new Set([...waiting, ...awaiting])].sort()) reconciled.push(await reconcileRun(tenant, run_id));
      return reconciled;
    },
  };
}
