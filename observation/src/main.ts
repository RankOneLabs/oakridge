import { createStageSource } from "./producers/oakridge/stage-source";
import type { RunStageSource } from "./grading/task-stages";
import { createGradingConfigStore } from "./grading/configuration-store";
import { parseGradingDefinitions, planRegistration, selectedRunners, type GradingRegistry, type GradingRegistration } from "./grading/configuration";
import { createGradingPublication, producerTenants } from "./grading/publication";
import { requireRunnerCredentials } from "./grading/provider-credentials";
import { createApp } from "./http/app";
import { RuntimeConfiguration, runtimeSnapshot } from "./grading/runtime-configuration";
import { credentialsFromEnv } from "./http/ingest-auth";
import type { RepositoryReader } from "./ports/artifact-source";
import { oakridgeGradingRegistry, oakridgeProfile } from "./producers/oakridge/profile";
import { err, ok, type Result } from "./domain/primitives";
import { openDatabase, type Database, type TenantScope } from "./storage/database";
import { createEvidenceReconciler, type EvidenceReconciler } from "./storage/evidence-pipeline";
import { gradingControls } from "./grading/budget";
import { registryRunners, startGradingWorker, type RunnerResolver } from "./grading/worker";
import { createGitRepositoryReader } from "./storage/git-repository-reader";
import { registerDefinitions } from "./storage/grading-store";
import { migrateEmptyDatabase } from "./storage/migrate";

export { graderCapability } from "./grading/runtime-configuration";
export { producerTenants } from "./grading/publication";

export interface StartupError { readonly operation: "startup"; readonly kind: string; readonly entity_id: string; readonly detail: string }
const startupError = (kind: string, entity_id: string, detail: string): Result<never, StartupError> =>
  err({ operation: "startup", kind, entity_id, detail });

/** Published definitions, checked against the producer registry, retained runners and the service's
 * own environment. Nothing is registered unless every configured grader could run. */
export function prepareGrading(graders: unknown, registry: GradingRegistry, env: NodeJS.ProcessEnv): Result<GradingRegistration, StartupError> {
  const configuration = parseGradingDefinitions(graders, registry);
  if (!configuration.ok) return startupError(configuration.error.kind, configuration.error.entity_id, configuration.error.detail);
  const registration = planRegistration(configuration.value, registry);
  if (!registration.ok) return startupError(registration.error.kind, registration.error.entity_id, registration.error.detail);
  const credentials = requireRunnerCredentials(selectedRunners(configuration.value), env);
  if (!credentials.ok) return startupError(credentials.error.kind, credentials.error.entity_id, credentials.error.detail);
  return registration;
}

async function registerAll(db: Database, tenants: readonly TenantScope[], registration: GradingRegistration): Promise<Result<void, StartupError>> {
  for (const tenant of tenants) {
    const registered = await registerDefinitions(db, tenant, registration);
    if (!registered.ok) return startupError("registration_failed", registered.error.entity_id, registered.error.detail);
  }
  return ok(undefined);
}

export interface StartupOptions {
  readonly stage_source?: RunStageSource;
  readonly grading_config_dir?: string;
  readonly repository?: RepositoryReader;
  /** Resolves each pinned evaluator's runner; the retained registry unless a test supplies one. */
  readonly runners?: RunnerResolver;
  /** How often every tenant is reconciled, besides after each accepted event. */
  readonly reconcile_ms?: number;
  readonly worker_idle_ms?: number;
}

const RECONCILE_MS = 15_000;

/** Reconciles every tenant now and then at an interval until stopped, so a question whose input
 * arrives without a new event, or ready work of an enabled run, is still taken up. */
/** One sweep at a time: a tick that arrives while a sweep is still running is skipped, so slow
 * sweeps never queue up behind each other. */
export function startReconcileSweep(reconciler: Pick<EvidenceReconciler, "reconcileAll">, tenants: readonly TenantScope[], interval_ms: number)
  : { stop(): Promise<void> } {
  let current: Promise<void> | null = null;
  const sweep = (): void => {
    if (current) return;
    current = (async () => {
      for (const tenant of tenants) await reconciler.reconcileAll(tenant)
        .catch((error: unknown) => console.error("[observation] reconciliation failed", { namespace: tenant.namespace, error }));
    })().finally(() => { current = null; });
  };
  sweep();
  const timer = setInterval(sweep, interval_ms);
  return { async stop() { clearInterval(timer); await current; } };
}

/** The composition root: the one place that names a producer and hands it to generic code. */
export async function startObservation(env: NodeJS.ProcessEnv = process.env, options: StartupOptions = {}): Promise<{
  readonly port: number; stop(): Promise<void> }> {
  if (!env.OBSERVATION_DATABASE_URL) throw new Error("OBSERVATION_DATABASE_URL is required");
  const grading_config_dir = options.grading_config_dir ?? env.OBSERVATION_GRADING_CONFIG_DIR;
  if (!grading_config_dir) throw new Error("OBSERVATION_GRADING_CONFIG_DIR is required");
  const credentials = credentialsFromEnv(env);
  const store = createGradingConfigStore(grading_config_dir);
  const latest = await store.latestVersion();
  if (!latest.ok) throw new Error(`observation cannot start: ${latest.error.version === undefined ? "" : `grading configuration version ${latest.error.version} (hash ${latest.error.hash}): `}${latest.error.kind}: ${latest.error.entity_id}: ${latest.error.detail}`);
  const document = latest.value;
  const configurationError = (error: StartupError): Error => new Error(`observation cannot start: grading configuration version ${document?.version} (hash ${document?.hash}): ${error.kind}: ${error.entity_id}: ${error.detail}`);
  const registration = document ? prepareGrading(document.definitions, oakridgeGradingRegistry, env) : planRegistration([], oakridgeGradingRegistry);
  if (!registration.ok) throw configurationError({ ...registration.error, operation: "startup" });
  const runtime = new RuntimeConfiguration(runtimeSnapshot({ version: document?.version ?? null, hash: document?.hash ?? null, registration: registration.value,
    profile: oakridgeProfile(registration.value.questions, registration.value.collector), applied_at: new Date().toISOString() }));
  const controls = gradingControls(env);
  if (!controls.ok) throw new Error(`observation cannot start: invalid_controls: ${controls.error.entity_id}: ${controls.error.detail}`);
  const db = openDatabase(env.OBSERVATION_DATABASE_URL);
  try {
    await migrateEmptyDatabase(db);
    const tenants = producerTenants(credentials, runtime.current().profile.producer);
    const registered = document ? await registerAll(db, tenants, registration.value) : ok(undefined);
    if (!registered.ok) throw configurationError(registered.error);
    console.info("[observation] registered grading definitions", { tenants: tenants.length,
      questions: registration.value.questions.map((question) => `${question.question_id}@${question.question_version}`),
      evaluators: registration.value.evaluators.map((evaluator) => `${evaluator.backend_kind}:${evaluator.evaluator_definition_id}`) });
    const evidence = createEvidenceReconciler({ db, runtime_configuration: runtime, repository: options.repository ?? createGitRepositoryReader(),
      admission: { retry_limit: controls.value.retry_limit } });
    const publication = createGradingPublication({ db, store, runtime, registry: oakridgeGradingRegistry, credentials, env,
      profile: (registration) => oakridgeProfile(registration.questions, registration.collector) });
    const app = createApp({ db, credentials, runtime_configuration: runtime,
      grading_config: { store, runtime, publication, registry: oakridgeGradingRegistry, env },
      stage_source: options.stage_source ?? createStageSource({ base_url: env.OAKRIDGE_CORE_BASE_URL ?? "http://127.0.0.1:8790", token: env.OAKRIDGE_CORE_CONTROL_TOKEN ?? env.OAKRIDGE_CONTROL_TOKEN }), evidence,
      grader_capability: () => runtime.current().grader_capability });
    const server = Bun.serve({ fetch: app.fetch, hostname: env.OBSERVATION_HOST ?? "127.0.0.1", port: Number(env.OBSERVATION_PORT ?? 8791) });
    // Work an earlier process left is taken up: waiting questions, ready questions to admit, and
    // executions whose claims expired.
    const sweep = startReconcileSweep(evidence, tenants, options.reconcile_ms ?? RECONCILE_MS);
    const worker = startGradingWorker({ db, tenants, controls: controls.value, idle_ms: options.worker_idle_ms,
      runners: options.runners ?? registryRunners(controls.value, env) });
    console.info("[observation] automatic grading", { run_spend: controls.value.run_spend, retry_limit: controls.value.retry_limit,
      lease_ms: controls.value.lease_ms, provider_deadline_ms: controls.value.provider_deadline_ms });
    return { port: server.port ?? Number(env.OBSERVATION_PORT ?? 8791),
      stop: async () => { server.stop(); await sweep.stop(); await worker.stop(); await db.destroy(); } };
  } catch (error) { await db.destroy(); throw error; }
}

if (import.meta.main) await startObservation();
