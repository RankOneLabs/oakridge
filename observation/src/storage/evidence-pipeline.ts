import type { RepositoryReader } from "../ports/artifact-source";
import type { EvidenceCollector } from "../ports/producer-profile";
import { CaptureArtifactSource } from "./capture-artifact-source";
import { collectWaitingEvidence, readWaitingRuns, type RunCollection } from "./captured-evidence-store";
import type { Database, TenantScope } from "./database";

/** Collects waiting questions when their input may have arrived. It reads captured copies and
 * the repositories they name; it creates no execution and calls no provider. */
export interface EvidencePipeline {
  /** One pass over a run's waiting questions. Passes for the same run never overlap, and a request
   * made during a pass gets a fresh pass after it, so input that arrived meanwhile is seen. */
  collectRun(tenant: TenantScope, run_id: string): Promise<RunCollection>;
  /** Every run with a waiting question, as at startup. */
  collectWaiting(tenant: TenantScope): Promise<readonly RunCollection[]>;
}
export interface EvidencePipelineDependencies {
  readonly db: Database;
  readonly collector: EvidenceCollector;
  readonly repository: RepositoryReader;
  readonly log?: (message: string, detail: Readonly<Record<string, unknown>>) => void;
}

const defaultLog = (message: string, detail: Readonly<Record<string, unknown>>): void => console.info(`[observation] ${message}`, detail);

export function createEvidencePipeline(deps: EvidencePipelineDependencies): EvidencePipeline {
  const log = deps.log ?? defaultLog;
  const running = new Map<string, Promise<RunCollection>>();
  const queued = new Map<string, Promise<RunCollection>>();
  const pass = async (tenant: TenantScope, run_id: string): Promise<RunCollection> => {
    const source = new CaptureArtifactSource({ db: deps.db, tenant, run_id, collector: deps.collector, repository: deps.repository });
    const collected = await collectWaitingEvidence(deps.db, tenant, source, run_id);
    if (collected.ready.length + collected.waiting.length + collected.failed.length > 0)
      log("evidence collected", { producer: tenant.producer, namespace: tenant.namespace, run_id, ready: collected.ready.length,
        waiting: collected.waiting.map((entry) => entry.code), failed: collected.failed.map((entry) => entry.detail) });
    return collected;
  };
  const collectRun = (tenant: TenantScope, run_id: string): Promise<RunCollection> => {
    const key = JSON.stringify([tenant.producer, tenant.namespace, run_id]);
    const behind = queued.get(key);
    if (behind) return behind;
    const current = running.get(key);
    const start = (): Promise<RunCollection> => {
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
    collectRun,
    async collectWaiting(tenant) {
      const collected: RunCollection[] = [];
      for (const run_id of await readWaitingRuns(deps.db, tenant)) collected.push(await collectRun(tenant, run_id));
      return collected;
    },
  };
}
