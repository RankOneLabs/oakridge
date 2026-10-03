import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { ImplementationCohortInputs, ArtifactRef, PreparedImplementationRepository } from "../domain/dev-flow-v15";
/**
 * How an Oakridge backend is assembled.
 *
 * This used to live inline in `src/main.ts`, which meant the composition was a
 * script rather than a value: nothing but the process could build it, so
 * nothing but the process ever ran the real repositories, the real dispatchers
 * and the real HTTP routes together. Every test above unit scope had to rebuild
 * a smaller, differently-shaped system out of stubs — and the defects this
 * project keeps shipping live exactly in the seams those stubs paper over.
 *
 * `main.ts` is the process wrapper: environment, listener, timers, signals.
 * Everything that decides what the backend *is* happens here, once, for both
 * the process and the end-to-end tests.
 *
 * Two v14 calls are deliberately absent. `requireV2CutoverDatabase` is gone
 * because v15 is a clean baseline, not an upgrade — there is no pre-cutover
 * shape left to refuse. `registerRunRecordWorkflowServices` is still here, but
 * what it registers is the v15 topology: one machine per decision owner rather
 * than one root workflow that asked for the whole run's next move.
 */
import { DBOS, DBOSClient } from "@dbos-inc/dbos-sdk";
import type { Hono } from "hono";

import { createDevFlowAdapterRegistry, registerDevFlowCohortDetails } from "../adapters/dev-flow";
import { RepositoryProvisioningAdapter } from "../adapters/repository-provisioning";
import { compileWorkflowDefinition } from "../compiler/compile-workflow";
import { stageInstanceIdFor } from "../decision/ids";
import { createLegacyValidationRegistry } from "../compiler/compile-workflow";
import { DEV_FLOW_ARTIFACT_TYPES, findArtifactType } from "../domain/artifact-types";
import type { ArtifactEnvelope, ExecutionRequest, ExecutorAdapter } from "../domain/execution";
import { err, ok, type AttemptId, type JsonValue, type Result, type UnitId, type WorkOrderId, type WorkflowRunId } from "../domain/primitives";
import { parseGithubPullRequestIdentity, repositoriesMatch } from "../domain/pull-request";
import type { GitCommandRunner } from "../domain/repository-provisioning";
import type { InitializeStageInstance } from "../domain/run-record";
import type { RetryCohortResult, RetryCohortTarget } from "../domain/run-record";
import { selectOrphanedVersionRuns, type OrphanedVersionRuns } from "../domain/workflow-recovery";
import type { PromptBundleEntry } from "../domain/workflow";
import { parseWorkflowDefinition } from "../validation/workflow-definition";
import { STAGE_CONTRACT_DEPENDENCY_KEY } from "../storage/load-run-snapshot";
import { STAGE_CONTRACT_INPUT_EDGES_KEY } from "../domain/stage-contract";
import { pollStagePullRequests, type PullRequestReader, type StagePullRequestPollOutcome } from "./github-pull-requests";
import { createApp } from "../http/app";
import { registerDbosTransportClient, sendRunWakeHint } from "../http/dbos-transport";
import { seedBuiltins } from "../seed/seed-builtins";
import {
  PostgresForgeRepositoryRepository,
  PostgresArtifactRepository,
  PostgresCollaborationRepository,
  PostgresStageInstanceRepository,
  PostgresWorkflowRunRepository,
} from "../storage/postgres-domain";
import { PostgresOperatorProjectionRepository } from "../storage/postgres-operators";
import { PostgresProjectRepository } from "../storage/postgres-projects";
import { PostgresRunRecordWriter } from "../storage/postgres-run-record";
import { PostgresRunRecordRepository } from "../storage/postgres-run-record-repository";
import { PostgresDevFlowPullRequestRepository } from "../storage/postgres-dev-flow";
import { StageEventApplier } from "../storage/apply-stage-event";
import { PostgresWorkflowDefinitionRepository } from "../storage/postgres-workflow-definitions";
import { PgPostgresExecutor } from "../storage/sql-executor";
import { findExecutorAdapter, registerExecutorAdapter } from "./executor-registry";
import { registerRunRecordWorkflowServices, workerExecutionWorkflow } from "../workflows/run-record-topology";
import "../workflows/collaboration-responder";
import { DbosRunLaunchClient } from "./dbos-run-launch-client";
import { DbosCollaborationPingClient, PostgresSessionMessageRecipientResolver, PostgresSessionMessageRepository } from "./collaboration-ping";
import { BunGitCommandRunner } from "./git-command-runner";
import { createPromptTemplateLoader, renderActionPrompt, type ReferencedActionArtifact } from "./prompt-template";
import { GitProjectRepositoryIdentityResolver } from "./project-identity";
import { dispatchRunLaunches, dispatchCohortExecution, stopCohortExecution, type WorkerSessionIO } from "./run-launch-dispatch";
import { publishWorkOrderArtifact } from "./publish-work-order-artifact";
import { prepareDevFlowBuildCohort, verifyAndBindCohortPullRequest, verifyCohortPullRequest } from "./cohort-pull-request";

const isJsonObject = (value: JsonValue): value is { readonly [key: string]: JsonValue } =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface OakridgeRuntimeConfig {
  readonly database_url: string;
  /**
   * Scopes DBOS workflow recovery. Also stamped on enqueued run launches, so a
   * launch is only picked up by a backend of the same version.
   */
  readonly application_version: string;
  /**
   * How a cohort's work actually gets done, one adapter per stage type. The
   * agent-facing one is the collaborator a test replaces; the deterministic
   * repository provisioner is built here, because it publishes its artifact
   * through the same transform the emit route uses and only this composition
   * holds the repositories that transform needs.
   */
  readonly executor_adapters: readonly ExecutorAdapter[];
  readonly prompt_template_directory: string;
  /** Bearer token required on state-changing requests; absent on a loopback bind. */
  readonly control_token?: string;
  readonly git_commands?: GitCommandRunner;
  readonly pull_request_reader: PullRequestReader;
  readonly pull_request_poll_interval_ms?: number;
  readonly now?: () => string;
}

export interface OakridgeRuntime {
  readonly app: Hono;
  /** Starts the root machine of every run whose intent is stored but unstarted. */
  dispatch_launches(): Promise<number>;
  /** Writes the built-in workflow definitions. Safe to call repeatedly. */
  seed_builtins(): Promise<void>;
  poll_pull_requests(): Promise<readonly StagePullRequestPollOutcome[]>;
  readonly pull_request_poll_interval_ms: number;
  start_unstarted_effects(): Promise<number>;
  is_pull_request_poll_running(): boolean;
  pause_pull_request_polling(): Promise<() => void>;
  /**
   * Runs this executor has inherited from an application version it cannot
   * recover. Empty on a healthy start; anything here will never advance on its
   * own and has to be cancelled.
   */
  orphaned_version_runs(): Promise<readonly OrphanedVersionRuns[]>;
  /** Settles in-flight dispatch, then closes the SQL pool and DBOS client. */
  close(): Promise<void>;
}

export const createOakridgeRuntime = async (config: OakridgeRuntimeConfig): Promise<OakridgeRuntime> => {
  const pullRequestPollIntervalMs = config.pull_request_poll_interval_ms
    ?? Number(process.env.OAKRIDGE_PULL_REQUEST_POLL_SECONDS ?? "60") * 1_000;
  if (!Number.isFinite(pullRequestPollIntervalMs) || pullRequestPollIntervalMs < 1_000) {
    throw new Error("OAKRIDGE_PULL_REQUEST_POLL_SECONDS must be at least 1 second");
  }
  const now = config.now ?? (() => new Date().toISOString());
  const sql = PgPostgresExecutor.connect(config.database_url);
  const git = config.git_commands ?? new BunGitCommandRunner();
  const cohortPullRequests = new PostgresDevFlowPullRequestRepository(sql);
  const client = await DBOSClient.create({ systemDatabaseUrl: config.database_url });

  const adapterRegistry = createDevFlowAdapterRegistry();
  const projects = new PostgresProjectRepository(sql);
  const projectIdentity = new GitProjectRepositoryIdentityResolver();
  const runs = new PostgresWorkflowRunRepository(sql);
  const promptTemplates = createPromptTemplateLoader(config.prompt_template_directory);
  const writer = new PostgresRunRecordWriter(sql, adapterRegistry);
  const machineRegistry = createLegacyValidationRegistry();
  const definitions = new PostgresWorkflowDefinitionRepository(sql, adapterRegistry, machineRegistry);
  const stages = new PostgresStageInstanceRepository(sql);
  const forgeRepositories = new PostgresForgeRepositoryRepository(sql);
  const stageEvents = new StageEventApplier({ sql, writer,
    observe_pr: async (cohort_id) => {
      const rows = await sql.query<{ readonly run_id: WorkflowRunId; readonly stage_instance_id: import("../domain/primitives").StageInstanceId;
        readonly cohort_key: string }>(
        "SELECT run_id::text,stage_instance_id::text,cohort_key FROM oakridge.cohort WHERE id=$1", [cohort_id]);
      const row = rows[0];
      if (!row) return null;
      const current = await cohortPullRequests.find_current_for_unit(row.stage_instance_id, row.cohort_key as UnitId);
      if (!current) return null;
      const forge = await forgeRepositories.find_forge_repository(row.run_id, current.cohort.repository_key);
      if (!forge) return null;
      const verified = await verifyCohortPullRequest({ reader: config.pull_request_reader, git }, {
        cohort: current.cohort, forge_repository: forge, candidate_url: current.pull_request.url,
      });
      if (!verified.ok) return null;
      const observation = verified.value.observation;
      return { pr_url: observation.url, repository_key: current.cohort.repository_key as never,
        head_branch: observation.head_branch, base_branch: observation.base_branch,
        head_sha: verified.value.pushed_head_sha as never,
        state: observation.state === "closed_unmerged" ? "closed" : observation.state };
    },
    prepare_repository: async (cohort_id) => {
      const rows = await sql.query<{ readonly stage_instance_id: import("../domain/primitives").StageInstanceId;
        readonly cohort_key: string; readonly state: string; readonly frozen_inputs: ImplementationCohortInputs }>(
        "SELECT stage_instance_id::text,cohort_key,state,frozen_inputs FROM oakridge.cohort WHERE id=$1", [cohort_id]);
      const row = rows[0];
      if (!row) return err({ detail: "implementation cohort is missing" });
      if (row.state === "awaiting_merge" || row.state === "complete" || row.state === "failed" || row.state === "cancelled")
        return ok(undefined);
      const repository = row.frozen_inputs.repository;
      if (repository.worktree_base_sha) return existsSync(repository.worktree_path)
        ? ok(undefined) : err({ detail: "prepared cohort worktree is missing" });
      const prepared = await prepareDevFlowBuildCohort({ pull_requests: cohortPullRequests, git }, {
        cohort_id, stage_instance_id: row.stage_instance_id, cohort_key: row.cohort_key,
        repository: row.frozen_inputs.repository.refs, prepared_at: now(),
      });
      if (!prepared.ok) return err({ detail: prepared.error.detail });
      if (prepared.value.cohort.canonical_ref !== repository.canonical_branch
        || prepared.value.cohort.expected_pr_base !== repository.expected_pr_base)
        return err({ detail: "prepared cohort branch disagrees with the frozen repository input" });
      if (existsSync(repository.worktree_path)) {
        const branch = await git.run(repository.worktree_path, ["rev-parse", "--abbrev-ref", "HEAD"]);
        const ancestry = await git.run(repository.worktree_path,
          ["merge-base", "--is-ancestor", prepared.value.worktree_base_sha, "HEAD"]);
        if (branch.exit_code !== 0 || branch.stdout.trim() !== repository.canonical_branch || ancestry.exit_code !== 0)
          return err({ detail: "prepared worktree does not match the cohort branch and observed base" });
      } else {
        const created = await git.run(repository.refs.repository_path, ["worktree", "add", "--no-track", "-b",
          repository.canonical_branch, repository.worktree_path, prepared.value.worktree_base_sha]);
        if (created.exit_code !== 0) return err({ detail: created.stderr.trim() || "could not create the cohort worktree" });
      }
      await sql.query(`UPDATE oakridge.cohort SET frozen_inputs=jsonb_set(frozen_inputs,
        '{repository,worktree_base_sha}',to_jsonb($2::text))
        WHERE id=$1 AND frozen_inputs #>> '{repository,worktree_base_sha}' IS NULL`,
      [cohort_id, prepared.value.worktree_base_sha]);
      return ok(undefined);
    },
    dispatch_executions: async (ids) => {
      for (const execution_id of ids) await DBOS.startWorkflow(workerExecutionWorkflow,
        { workflowID: `v15-worker:${execution_id}` })(execution_id);
    }, now });
  const runRecords = new PostgresRunRecordRepository(sql, writer, stageEvents);
  const artifacts = new PostgresArtifactRepository(sql);
  const collaboration = new PostgresCollaborationRepository(sql);
  const projections = new PostgresOperatorProjectionRepository(sql, config.application_version, adapterRegistry);
  registerDevFlowCohortDetails(projections, sql);
  const messages = new PostgresSessionMessageRepository(sql);
  const messageRecipients = new PostgresSessionMessageRecipientResolver(sql);

  const dbosRuns = new DbosRunLaunchClient(client);
  const collaborationPings = new DbosCollaborationPingClient(client, config.application_version, messages);

  // HTTP handlers and the periodic workers share these dispatch functions. Keep
  // every invocation in the same in-flight set so shutdown cannot close the SQL
  // pool while a request-triggered dispatcher is still using it.
  const inFlightDispatches = new Set<Promise<unknown>>();
  let isDispatchClosing = false;
  const trackDispatch = <Value>(operation: () => Promise<Value>): Promise<Value> => {
    if (isDispatchClosing) return Promise.reject(new Error("Oakridge is shutting down; durable dispatch remains queued"));
    const pending = operation();
    inFlightDispatches.add(pending);
    void pending.finally(() => inFlightDispatches.delete(pending)).catch(() => undefined);
    return pending;
  };
  const dispatchLaunches = () => trackDispatch(() => dispatchRunLaunches(runs, dbosRuns, config.application_version));

  registerDbosTransportClient(client);
  for (const adapter of config.executor_adapters) registerExecutorAdapter(adapter);
  const enrichStagePublication = async (input: { readonly attempt_id: AttemptId;
    readonly output_name: string; readonly body: JsonValue }): Promise<Result<JsonValue | null,
      { readonly code: string; readonly detail: string }>> => {
    if (input.output_name !== "pr_summary") return ok(null);
    const rows = await sql.query<{ readonly run_id: WorkflowRunId; readonly repository_key: string;
      readonly repository_path: string; readonly canonical_ref: string; readonly expected_pr_base: string;
      readonly stage_instance_id: import("../domain/primitives").StageInstanceId; readonly cohort_key: string;
      readonly action_point: string }>(
      `SELECT attempt.run_id,build.repository_key,build.repository_path,build.canonical_ref,build.expected_pr_base,
         build.stage_instance_id,build.cohort_key,intent.action_point
       FROM oakridge.attempt attempt JOIN dev_flow.build_cohort build ON build.cohort_id=attempt.cohort_id
       JOIN oakridge.execution_intent intent ON intent.attempt_id=attempt.id
       WHERE attempt.id=$1`, [input.attempt_id]);
    const roles = rows[0];
    const expected_repository = roles ? await forgeRepositories.find_forge_repository(roles.run_id, roles.repository_key) : null;
    const base = { expected_repository, expected_pr_base: roles?.expected_pr_base ?? null,
      canonical_ref: roles?.canonical_ref ?? null };
    const url = isJsonObject(input.body) && typeof input.body.pr_url === "string" ? input.body.pr_url : null;
    const identity = url ? parseGithubPullRequestIdentity(url) : null;
    const invalid = (detail: string) => err({ code: "pr_verification_failed", detail });
    if (!url || !identity || !roles || !expected_repository) return invalid("PR identity or repository authority is missing");
    if (!isJsonObject(input.body) || input.body.repository_key !== roles.repository_key
      || input.body.branch !== roles.canonical_ref || input.body.base_branch !== roles.expected_pr_base)
      return invalid("PR summary disagrees with the cohort repository or branch contract");
    if (!repositoriesMatch(identity.owner, identity.name, expected_repository.owner, expected_repository.name))
      return invalid("PR URL belongs to a different repository");
    const reader = config.pull_request_reader;
    if (!reader) return err({ code: "enrichment_unavailable", detail: "GitHub reader is not configured" });
    const reading = await reader.read(identity.owner, identity.name, identity.number);
    if (!reading.ok) return err({ code: "enrichment_unavailable", detail: reading.error.detail });
    if (reading.value === null) return invalid("PR was not found at the forge");
    const observed = reading.value;
    if (!repositoriesMatch(observed.owner, observed.name, expected_repository.owner, expected_repository.name)
      || observed.number !== identity.number || observed.head_branch !== roles.canonical_ref
      || observed.base_branch !== roles.expected_pr_base || !observed.head_sha)
      return invalid("forge PR observation disagrees with the cohort repository, branches, or head");
    const ref = `refs/heads/${roles.canonical_ref}`;
    let remote: Awaited<ReturnType<GitCommandRunner["run"]>>;
    try { remote = await git.run(roles.repository_path, ["ls-remote", "origin", ref]); }
    catch (error) { return err({ code: "enrichment_unavailable", detail: String(error) }); }
    if (remote.exit_code !== 0) return err({ code: "enrichment_unavailable", detail: remote.stderr.trim() || "origin could not be read" });
    const origin_head_sha = remote.stdout.trim().split(/\s+/)[0] || null;
    if (origin_head_sha !== observed.head_sha) return invalid("forge PR head differs from the pushed cohort head");
    const cohort = await cohortPullRequests.find_cohort_for_unit(roles.stage_instance_id, roles.cohort_key as UnitId);
    if (!cohort) return invalid("prepared cohort repository is missing");
    const current = await cohortPullRequests.find_current_for_unit(roles.stage_instance_id, roles.cohort_key as UnitId);
    const bound = await verifyAndBindCohortPullRequest({ pull_requests: cohortPullRequests,
      reader: config.pull_request_reader, git, now }, { cohort, forge_repository: expected_repository,
      candidate_url: url, replace_verification_id: roles.action_point === "replace_pr"
        ? current?.cohort.current_verified_pull_request_id ?? null : null });
    if (!bound.ok) return invalid(bound.error.detail);
    return ok({ ...base, pr: bound.value.observation as unknown as JsonValue, origin_head_sha: bound.value.head_sha });
  };
  registerExecutorAdapter(new RepositoryProvisioningAdapter({
    git,
    publish_work_order: async (request) => {
      const result = await publishWorkOrderArtifact({
        attempt_id: request.work_order_id as unknown as AttemptId, capability: request.capability,
        output_name: request.output_name, collection_key: null, body: request.body,
        idempotency_key: request.idempotency_key,
      }, { records: runRecords, now });
      if (result.kind === "published" || result.kind === "pending" || result.kind === "already_applied") {
        await sendRunWakeHint(result.run_id, `provision:${result.artifact_id}`).catch(() => undefined);
      }
      return result;
    },
  }));

  /**
   * The stage contract a run's stages are opened with, compiled from the
   * definition version the run was launched against.
   *
   * `dependency_stage_instance_ids` is written beside the compiled contract
   * rather than inside it: `derive` closes over stage-instance ids, and core has
   * no business resolving a definition's stage *names* at decision time. The
   * projections still read `stage_contract->>'operator_role'`, so the compiled
   * contract keeps its own shape untouched.
   */
  const compileRunStages = async (run_id: WorkflowRunId): Promise<readonly InitializeStageInstance[]> => {
    const launch = await runs.find_launch_by_id(run_id);
    if (!launch) throw new Error(`workflow run '${run_id}' was not found`);
    const definition = await definitions.find_by_id(launch.workflow_definition_id);
    if (!definition) throw new Error(`workflow definition '${launch.workflow_definition_id}' was not found`);
    const parsed = parseWorkflowDefinition(definition, adapterRegistry);
    if (!parsed.ok) throw new Error(`run ${run_id}'s definition is invalid: ${parsed.error.detail}`);
    const compiled = compileWorkflowDefinition(parsed.value, undefined, adapterRegistry, machineRegistry);
    if (!compiled.ok) throw new Error(`run ${run_id}'s definition does not compile: ${compiled.error.detail}`);
    const producers = new Map<string, Set<string>>();
    for (const edge of compiled.value.edges) {
      const existing = producers.get(edge.consumer_stage) ?? new Set<string>();
      existing.add(edge.producer_stage);
      producers.set(edge.consumer_stage, existing);
    }
    const collecting = new Map<string, boolean>();
    for (const [stage_key, contract] of Object.entries(compiled.value.stages)) {
      for (const input of contract.inputs) collecting.set(`${stage_key}:${input.name}`, input.collect);
    }
    return Object.entries(compiled.value.stages).map(([stage_key, contract]) => ({
      id: stageInstanceIdFor(run_id, stage_key),
      stage_key,
      stage_type: contract.stage_type,
      stage_contract: { ...(contract as unknown as Record<string, JsonValue>),
        [STAGE_CONTRACT_DEPENDENCY_KEY]: [...(producers.get(stage_key) ?? [])].sort()
          .map((producer) => stageInstanceIdFor(run_id, producer) as string),
        [STAGE_CONTRACT_INPUT_EDGES_KEY]: compiled.value.edges
          .filter((edge) => edge.consumer_stage === stage_key)
          .map((edge) => ({ input_name: edge.consumer_input,
            producer_stage_instance_id: stageInstanceIdFor(run_id, edge.producer_stage) as string,
            producer_output: edge.producer_output,
            collect: collecting.get(`${stage_key}:${edge.consumer_input}`) === true })),
      } as JsonValue,
      dependency_stage_instance_ids: [...(producers.get(stage_key) ?? [])].sort()
        .map((producer) => stageInstanceIdFor(run_id, producer)),
    }));
  };

  const runContextOf = async (run_id: WorkflowRunId): Promise<JsonValue | null> => {
    const launch = await runs.find_launch_by_id(run_id);
    return launch ? launch.context as JsonValue : null;
  };

  const promptBundleOf = async (run_id: WorkflowRunId): Promise<readonly PromptBundleEntry[]> => {
    const launch = await runs.find_launch_by_id(run_id);
    if (!launch) throw new Error(`workflow run '${run_id}' was not found`);
    const bundle = await definitions.find_prompt_bundle(launch.bundle_pin.prompt_bundle_hash);
    if (!bundle) throw new Error(`run '${run_id}' is pinned to prompt bundle '${launch.bundle_pin.prompt_bundle_hash}', which is not stored`);
    return bundle.matrix;
  };

  const workerSessionIO: WorkerSessionIO = {
    now,
    create_session: async (intent) => {
      const rows = await sql.query<{ readonly frozen_inputs: ImplementationCohortInputs; readonly cohort_key: string }>(
        "SELECT frozen_inputs,cohort_key FROM oakridge.cohort WHERE id=$1", [intent.cohort_id]);
      const cohort = rows[0];
      const repository = cohort?.frozen_inputs.repository;
      if (!repository?.worktree_base_sha)
        return err({ detail: "prepared implementation repository is missing" });
      const bundle = await promptBundleOf(intent.run_id);
      const prompt = bundle.find((entry) => entry.template_path === intent.prompt);
      if (!prompt) return err({ detail: `pinned prompt ${intent.prompt} is unavailable` });
      const source = intent.resolved_input;
      const refs: ArtifactRef[] = [];
      const collect = (value: JsonValue): void => {
        if (Array.isArray(value)) { for (const member of value) collect(member); return; }
        if (!isJsonObject(value)) return;
        if (typeof value.id === "string" && typeof value.version === "number") {
          refs.push({ id: value.id as ArtifactRef["id"], version: value.version }); return;
        }
        for (const member of Object.values(value)) collect(member);
      };
      collect(source);
      const inputs: ArtifactEnvelope[] = [];
      const referenced: ReferencedActionArtifact[] = [];
      for (const ref of refs) {
        const artifacts = await sql.query<{ readonly id: string; readonly artifact_type: string; readonly body: JsonValue }>(
          `SELECT artifact.id::text,artifact.artifact_type,artifact.body FROM oakridge.artifact artifact
           JOIN oakridge.artifact_owner owner ON owner.artifact_id=artifact.id
           WHERE artifact.chain_id=$1 AND artifact.revision=$2 AND owner.run_id=$3`, [ref.id, ref.version, intent.run_id]);
        const artifact = artifacts[0];
        if (!artifact) return err({ detail: `pinned input ${ref.id}@${ref.version} is unavailable` });
        inputs.push({ artifact_id: artifact.id as ArtifactEnvelope["artifact_id"], artifact_type: artifact.artifact_type,
          output_name: artifact.artifact_type, unit_id: cohort.cohort_key as UnitId, body: artifact.body, chain_id: ref.id });
        referenced.push({ ref, artifact_type: artifact.artifact_type, body: artifact.body });
      }
      const declared_outputs = intent.worker === "build"
        ? [{ name: "build_result", artifact_type: "dev.build_result", required: true },
          { name: "pr_summary", artifact_type: "dev.pr_summary", required: true }]
        : [{ name: "assessment", artifact_type: "dev.assessment", required: true }];
      const adapter = findExecutorAdapter("delegated_session");
      if (!adapter) return err({ detail: "delegated session integration is unavailable" });
      const context = await runContextOf(intent.run_id);
      const base_url = isJsonObject(context ?? null) && typeof (context as { readonly oakridge_url?: JsonValue }).oakridge_url === "string"
        ? (context as { readonly oakridge_url: string }).oakridge_url : "";
      if (!base_url) return err({ detail: "run publication URL is unavailable" });
      const discussion = intent.worker === "assessment" && isJsonObject(source)
        ? intent.action_point === "discuss" ? source
          : intent.action_point === "retry" && isJsonObject(source.work) && source.work.action_point === "discuss"
            && isJsonObject(source.work.input) ? source.work.input : null
        : null;
      const unchanged = discussion && isJsonObject(discussion.current_assessment) && isJsonObject(discussion.accepted_build)
        ? { assessment: discussion.current_assessment, build: discussion.accepted_build } : null;
      const { capabilityFor } = await import("./resolve-work-order");
      const request: ExecutionRequest = {
        execution_id: intent.execution_id, stage_instance_id: intent.stage_instance_id, unit_id: cohort.cohort_key as UnitId,
        executor_type: "delegated_session", inputs, declared_outputs,
        expected_artifacts: declared_outputs.map((output) => ({ unit_id: cohort.cohort_key as UnitId,
          output_name: output.name, artifact_type: output.artifact_type })),
        resolved_config: { ...intent.settings, session_name: intent.execution_id, workdir: repository.worktree_path,
          rendered_prompt: renderActionPrompt({ template: prompt.content,
            fields: source as Readonly<Record<string, JsonValue>>, artifacts: referenced,
            execution: { worker: intent.worker, action_point: intent.action_point, cohort_id: intent.cohort_id },
            repository: repository as PreparedImplementationRepository }),
          publication: { base_url, work_order_id: intent.attempt_id,
            capability: capabilityFor(await runRecords.load_work_order_capability_seed(), intent.attempt_id as WorkOrderId) },
          ...(unchanged ? { assessment_unchanged: unchanged } : {}),
          session_identity: { run_id: intent.run_id, stage_instance_id: intent.stage_instance_id, unit_id: cohort.cohort_key,
            cohort_id: intent.cohort_id, operator_role: intent.worker, cohort_title: null,
            repository_key: repository.refs.repository_key },
        },
      };
      const { executorOperationIdForWorkOrder } = await import("../domain/primitives");
      const started = await adapter.start_or_attach(request, executorOperationIdForWorkOrder(intent.attempt_id as WorkOrderId));
      if (started.kind !== "kbbl_session") return err({ detail: started.kind === "executor_unavailable" ? started.detail : "integration did not create an agent session" });
      return ok({ execution_id: intent.execution_id, session_id: randomUUID() as import("../domain/primitives").SessionId,
        kbbl_session_id: started.session_id });
    },
    stop_session: async (session) => {
      const adapter = findExecutorAdapter("delegated_session");
      if (!adapter) return err({ detail: "delegated session integration is unavailable" });
      const stopped = await adapter.cancel_or_fence(session.execution_id,
        { kind: "kbbl_session", session_id: session.kbbl_session_id });
      return stopped?.kind === "executor_unavailable" ? err({ detail: stopped.detail }) : ok(undefined);
    },
  };
  const dispatchWorkerExecution = async (execution_id: import("../domain/primitives").ExecutionId): Promise<void> => {
    const dispatched = await dispatchCohortExecution(sql, execution_id, workerSessionIO);
    if (!dispatched.ok && dispatched.error.kind === "stop_failed") throw new Error(dispatched.error.detail);
    if (!dispatched.ok) console.warn(`worker execution ${execution_id}: ${dispatched.error.detail}`);
  };

  registerRunRecordWorkflowServices({
    records: runRecords, stages, artifacts, effects_sql: sql, stage_events: stageEvents, find_run_context: runContextOf,
    dispatch_worker_execution: dispatchWorkerExecution,
    find_executor: findExecutorAdapter, now,
  });

  const pollPullRequests = (): Promise<readonly StagePullRequestPollOutcome[]> =>
    trackDispatch(() => pollStagePullRequests({ sql, reader: config.pull_request_reader, stage_events: stageEvents }));
  const retryStageCohort = async (target: RetryCohortTarget, idempotency_key: string): Promise<RetryCohortResult> => {
    const cohort_id = target.kind === "cohort" ? target.cohort_id
      : (await runRecords.find_cohort_location(target.stage_instance_id,
        target.cohort_key as import("../domain/primitives").UnitId))?.cohort_id;
    if (!cohort_id) return { kind: "cohort_not_found", detail: "cohort not found" };
    const readClaim = () => runRecords.find_cohort_retry_claim(cohort_id, idempotency_key);
    const claim = await readClaim();
    const location = await sql.query<{ readonly run_id: string; readonly durable_version: string }>(
      "SELECT run_id::text,durable_version::text FROM oakridge.cohort WHERE id=$1", [cohort_id]);
    if (!location[0]) return { kind: "cohort_not_found", detail: "cohort not found" };
    if (!claim) {
      const applied = await stageEvents.apply(cohort_id, { kind: "operator_retry", idempotency_key, actor: "operator" });
      if (!applied.ok) return { kind: "refused", code: applied.error.kind, detail: applied.error.detail };
      if (applied.value.kind === "refused") {
        const raced = await readClaim();
        if (!raced) return { kind: "refused", code: applied.value.code, detail: applied.value.detail };
      } else if (applied.value.kind === "ignored") return { kind: "refused", code: applied.value.reason,
        detail: "cohort is terminal" };
    }
    const stored = await readClaim();
    if (!stored) return { kind: "refused", code: "attempt_missing", detail: "retry did not create an attempt" };
    return { kind: claim ? "already_created" : "created", run_id: location[0].run_id as WorkflowRunId,
      cohort_id, attempt_id: stored.attempt_id, attempt_number: stored.attempt_number,
      durable_version: stored.durable_version };
  };
  const startUnstartedEffects = async (): Promise<number> => {
    const intents = await sql.query<{ readonly id: import("../domain/primitives").ExecutionId }>(
      `SELECT id FROM oakridge.execution_intent WHERE status IN ('pending','dispatching')
       AND stop_requested_at IS NULL ORDER BY created_at LIMIT 100`, []);
    for (const intent of intents) await DBOS.startWorkflow(workerExecutionWorkflow,
      { workflowID: `v15-worker:${intent.id}` })(intent.id);

    const stops = await sql.query<{ readonly id: import("../domain/primitives").ExecutionId }>(
      `SELECT id FROM oakridge.execution_intent WHERE stop_requested_at IS NOT NULL AND stop_completed_at IS NULL
       ORDER BY stop_requested_at LIMIT 100`, []);
    for (const intent of stops) {
      const stopped = await stopCohortExecution(sql, intent.id, workerSessionIO);
      if (!stopped.ok) console.warn(`worker execution ${intent.id}: ${stopped.error.detail}`);
    }
    return intents.length + stops.length;
  };

  let effectSweep: Promise<unknown> | null = null;
  const effectSweepTimer = setInterval(() => {
    if (effectSweep) return;
    effectSweep = startUnstartedEffects()
      .catch((error: unknown) => { console.error("stage effect sweep failed", error); })
      .finally(() => { effectSweep = null; });
  }, 30_000);
  let pullRequestPoll: Promise<unknown> | null = null;
  let isPullRequestPollClosing = false;
  let pullRequestTimer: ReturnType<typeof setInterval> | null = null;
  const startPullRequestTimer = (): void => {
    if (isPullRequestPollClosing || pullRequestTimer) return;
    pullRequestTimer = setInterval(() => {
      if (pullRequestPoll) return;
      pullRequestPoll = pollPullRequests()
        .then((outcomes) => {
          for (const outcome of outcomes ?? []) if (outcome.kind === "unavailable")
            console.warn(`cohort ${outcome.cohort_id} pull request unavailable`);
        })
        .catch((error: unknown) => { console.error("cohort pull request poll failed", error); })
        .finally(() => { pullRequestPoll = null; });
    }, pullRequestPollIntervalMs);
  };
  startPullRequestTimer();

  const presentation = (artifactType: string) => {
    const definition = findArtifactType(artifactType);
    return definition ? { component_id: definition.component_id, capabilities: definition.capabilities,
      anchor_schema: definition.anchor_schema, review: definition.review as unknown as JsonValue } : null;
  };
  const collaborationPolicy = (artifactType: string) => {
    const definition = findArtifactType(artifactType);
    return definition ? { commentable: definition.capabilities.commentable,
      atom_editable: definition.capabilities.atom_editable } : null;
  };

  const app = createApp({
    configuration: { projects, definitions, project_identity: projectIdentity, now,
      prompt_templates: promptTemplates, adapter_roles: adapterRegistry },
    operator_retry: { retry_through_driver: retryStageCohort,
      submit_request: (envelope) => stageEvents.advance(envelope.cohort_id, envelope),
      abandon: async (cohort_id, detail) => {
        const result = await stageEvents.apply(cohort_id, { kind: "operator_abandon", actor: "operator", detail });
        if (result.ok && result.value.kind === "applied") {
          const run = await sql.query<{ readonly run_id: string }>(
            "SELECT run_id::text FROM oakridge.cohort WHERE id=$1", [cohort_id]);
          if (run[0]) await sendRunWakeHint(run[0].run_id as WorkflowRunId, `abandon:${result.value.transition_id}`);
        }
        if (!result.ok) return result.error.kind === "cohort_not_found"
          ? { kind: "not_found" as const }
          : { kind: "refused" as const, code: result.error.kind, detail: result.error.detail };
        return result.value.kind === "applied"
          ? { kind: "applied" as const, state: result.value.to }
          : { kind: "refused" as const, code: result.value.kind === "refused" ? result.value.code : result.value.reason,
            detail: result.value.kind === "refused" ? result.value.detail : "cohort is terminal" };
      } },
    run_lifecycle: { records: runRecords },
    domain_reads: { stages, artifacts, session_holds: projections, session_run_locations: projections },
    work_order_artifact_callback: { records: runRecords, enrich: enrichStagePublication,
      now, send_run_wake: sendRunWakeHint },
    gate_resume: { records: runRecords, now, send_run_wake: sendRunWakeHint },
    cohort_pull_requests: { refresh: async (cohort_id) => {
      const outcomes = await pollStagePullRequests({ sql, reader: config.pull_request_reader, stage_events: stageEvents }, cohort_id);
      if (outcomes.some((outcome) => outcome.kind === "unavailable")) return { ok: false, error: {
        operation: "refresh_pull_request", cohort_id, detail: "GitHub pull request status is unavailable; try again later",
      } };
      const rows = await sql.query<{ readonly state: string }>(
        "SELECT state FROM oakridge.cohort WHERE id=$1", [cohort_id]);
      return { ok: true, value: rows[0] ?? null };
    } },
    collaboration: { artifacts, collaboration, policy_for_artifact_type: collaborationPolicy,
      messages, message_recipients: messageRecipients,
      send_message: (input) => collaborationPings.enqueue(input),
      ping_thread: (input) => collaborationPings.enqueue(input) },
    operator_projections: projections,
    artifact_detail: { artifacts, stages, audits: artifacts, presentation_for_type: presentation, artifact_types: DEV_FLOW_ARTIFACT_TYPES },
    run_launch: { definitions, projects, runs, projections,
      start_run: async (request) => {
        // Every stage instance exists before the root machine runs, because
        // `derive` closes over the whole graph. Initialization is idempotent, so
        // the launch path and the unstarted sweep can both reach it.
        await runRecords.initialize_run({ run_id: request.run_id, stages: await compileRunStages(request.run_id), initialized_at: now() });
        return dbosRuns.start_v2_run(request);
      },
      application_version: config.application_version, adapter_version: "delegated-session-v1",
      artifact_schema_version: "v1", now },
    rerun: { v2_cancellation: { records: runRecords, find_executor: findExecutorAdapter, now, send_run_wake: sendRunWakeHint } },
    ...(config.control_token ? { control_token: config.control_token } : {}),
  });

  return {
    app,
    dispatch_launches: dispatchLaunches,
    start_unstarted_effects: startUnstartedEffects,
    seed_builtins: () => seedBuiltins(definitions),
    poll_pull_requests: pollPullRequests,
    pull_request_poll_interval_ms: pullRequestPollIntervalMs,
    is_pull_request_poll_running: () => pullRequestTimer !== null,
    async pause_pull_request_polling() {
      if (pullRequestTimer) clearInterval(pullRequestTimer);
      pullRequestTimer = null;
      await Promise.allSettled(pullRequestPoll ? [pullRequestPoll] : []);
      return startPullRequestTimer;
    },
    async orphaned_version_runs() {
      return selectOrphanedVersionRuns(await projections.list_application_versions(), config.application_version);
    },
    async close() {
      clearInterval(effectSweepTimer);
      await Promise.allSettled(effectSweep ? [effectSweep] : []);
      isPullRequestPollClosing = true;
      if (pullRequestTimer) clearInterval(pullRequestTimer);
      pullRequestTimer = null;
      await Promise.allSettled(pullRequestPoll ? [pullRequestPoll] : []);
      isDispatchClosing = true;
      await Promise.allSettled([...inFlightDispatches]);
      await client.destroy();
      await sql.close();
    },
  };
};
