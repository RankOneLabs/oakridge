import { repositoriesMatch } from "../domain/pull-request";
import { err, ok, type JsonValue } from "../domain/primitives";
import type { GuardContext, GuardName, ObserverName } from "../domain/stage-machine";
import type { ArtifactEnvelope } from "../domain/execution";
import type { StageMachineRegistry } from "../runtime/executor-registry";
import type { CohortEffectRow, RegisteredEffect } from "../decision/stage-effects";
import type { SqlExecutor } from "../storage/sql-executor";

const objectOf = (value: JsonValue | undefined): { readonly [key: string]: JsonValue } | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as { readonly [key: string]: JsonValue } : null;

const prOf = (context: GuardContext): { readonly [key: string]: JsonValue } | null =>
  context.event.kind === "artifact_published" ? objectOf(objectOf(context.event.enrichment ?? undefined)?.pr) : null;

const prMismatchDetail = (context: GuardContext): string | null => {
  const enrichment = context.event.kind === "artifact_published" ? objectOf(context.event.enrichment ?? undefined) : null;
  const pr = prOf(context);
  const artifact_id = context.event.kind === "artifact_published" ? context.event.artifact_id : null;
  const body = artifact_id === null ? null
    : objectOf(context.round_outputs.find((output) => output.artifact_id === artifact_id)?.body);
  if (!enrichment || !pr) return "pr.url could not be verified";
  const expected = objectOf(enrichment.expected_repository);
  if (!expected || typeof expected.owner !== "string" || typeof expected.name !== "string"
    || typeof pr.owner !== "string" || typeof pr.name !== "string"
    || !repositoriesMatch(pr.owner, pr.name, expected.owner, expected.name)) return "pr.repository does not match the cohort repository";
  if (pr.state !== "open") return "pr.state is not open";
  if (pr.base_branch !== enrichment.expected_pr_base || body?.base_branch !== enrichment.expected_pr_base)
    return "base.ref does not match the cohort base";
  if (pr.head_branch !== enrichment.canonical_ref || body?.branch !== enrichment.canonical_ref)
    return "head.ref does not match the cohort branch";
  if (pr.head_sha !== enrichment.origin_head_sha) return "head.sha does not match origin";
  const bound = objectOf(objectOf(context.stage_data)?.pull_request);
  if (bound !== null && bound.number !== pr.number) return "pr.number does not match the approved PR";
  return null;
};

export const prMatchesCohort = (context: GuardContext): boolean => prMismatchDetail(context) === null;

export const prMergedIntoBase = (context: GuardContext): boolean => {
  if (context.event.kind !== "external_observed") return false;
  const observation = objectOf(context.event.observation);
  const expected = objectOf(context.stage_data)?.expected_pr_base;
  return observation !== null && typeof observation.merged_at === "string" && observation.merged_at.length > 0
    && observation.base_branch === expected;
};

export const prClosedUnmerged = (context: GuardContext): boolean => {
  if (context.event.kind !== "external_observed") return false;
  const observation = objectOf(context.event.observation);
  return observation?.state === "closed_unmerged" && observation.merged_at === null;
};

const roundBriefs = (context: GuardContext): readonly { readonly key: string; readonly body: JsonValue }[] => {
  const stored = context.round_outputs.filter((output) => output.output === "brief" && output.collection_key)
    .map((output) => ({ key: output.collection_key!, body: output.body }));
  if (context.event.kind !== "artifact_published" || context.event.output !== "brief"
    || context.event.collection_key === null) return stored;
  const collection_key = context.event.collection_key;
  return stored.some((brief) => brief.key === collection_key) ? stored
    : [...stored, { key: collection_key,
      body: objectOf(context.event.enrichment ?? undefined)?.artifact_body ?? null }];
};

export const briefsCoverPlan = (context: GuardContext): boolean => {
  const plan = context.stage_inputs.plan;
  const envelope = Array.isArray(plan) ? plan[0] : plan as ArtifactEnvelope | undefined;
  const source = envelope?.body;
  const cohorts = objectOf(source)?.cohorts;
  if (!Array.isArray(cohorts)) return false;
  const expected = cohorts.map((cohort) => objectOf(cohort)?.id).filter((id): id is string => typeof id === "string");
  if (expected.length !== cohorts.length || expected.length === 0) return false;
  const observed = new Set(roundBriefs(context).map((brief) => brief.key));
  return expected.every((id) => observed.has(id));
};

export const briefsAcyclic = (context: GuardContext): boolean => {
  const briefs = roundBriefs(context);
  const graph = new Map(briefs.map((brief) => [brief.key, Array.isArray(objectOf(brief.body)?.depends_on)
    ? (objectOf(brief.body)?.depends_on as readonly JsonValue[]).filter((value): value is string => typeof value === "string") : []]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string): boolean => {
    if (visiting.has(key)) return false;
    if (visited.has(key)) return true;
    visiting.add(key);
    for (const dependency of graph.get(key) ?? []) if (graph.has(dependency) && !visit(dependency)) return false;
    visiting.delete(key);
    visited.add(key);
    return true;
  };
  return [...graph.keys()].every(visit);
};

const effectFailure = (cohort: CohortEffectRow, effect: string, detail: string) =>
  err({ operation: "stage_effect" as const, effect, cohort_id: cohort.id, detail });

const bindPullRequest: RegisteredEffect = async (tx, { cohort, event }) => {
  if (event.kind !== "artifact_published") return effectFailure(cohort, "bind_pull_request", "PR publication is required");
  const pr = objectOf(objectOf(event.enrichment ?? undefined)?.pr);
  if (!pr || typeof pr.number !== "number" || typeof pr.owner !== "string" || typeof pr.name !== "string"
    || typeof pr.url !== "string" || typeof pr.head_sha !== "string") return effectFailure(cohort, "bind_pull_request", "PR enrichment is missing");
  const pull = await tx.query<{ readonly id: string }>(
    `INSERT INTO dev_flow.pull_request (id,provider,owner,name,forge_pull_request_id,url,created_at)
     VALUES (gen_random_uuid(),'github',$1,$2,$3,$4,clock_timestamp())
     ON CONFLICT (provider,lower(owner),lower(name),forge_pull_request_id)
     DO UPDATE SET url=EXCLUDED.url RETURNING id::text`, [pr.owner, pr.name, pr.number, pr.url]);
  const pull_id = pull[0]?.id;
  if (!pull_id) return effectFailure(cohort, "bind_pull_request", "PR could not be stored");
  const observation = await tx.query<{ readonly id: string }>(
    `INSERT INTO dev_flow.pull_request_observation
       (id,pull_request_id,head_ref,base_ref,head_sha,state,source,observed_at,merged_at,recorded_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,'poll',$6::timestamptz,$7::timestamptz,clock_timestamp())
     RETURNING id::text`, [pull_id, pr.head_branch, pr.base_branch, pr.head_sha, pr.state,
      pr.observed_at, pr.merged_at]);
  await tx.query(
    `UPDATE dev_flow.pull_request_verification SET invalidated_at=clock_timestamp(),
       invalidation_reason='replaced' WHERE cohort_id=$1 AND invalidated_at IS NULL`, [cohort.id]);
  const verified = await tx.query<{ readonly id: string }>(
    `INSERT INTO dev_flow.pull_request_verification
       (id,cohort_id,pull_request_id,observation_id,verified_head_sha,verified_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4,clock_timestamp()) RETURNING id::text`,
    [cohort.id, pull_id, observation[0]?.id, pr.head_sha]);
  await tx.query(
    `UPDATE dev_flow.build_cohort SET current_verified_pull_request_id=$2,updated_at=clock_timestamp()
     WHERE cohort_id=$1`, [cohort.id, verified[0]?.id]);
  const data = objectOf(cohort.stage_data) ?? {};
  const enrichment = objectOf(event.enrichment ?? undefined);
  return ok({ stage_data: { ...data, pull_request: { number: pr.number, url: pr.url },
    expected_pr_base: enrichment?.expected_pr_base ?? null,
    canonical_ref: enrichment?.canonical_ref ?? null } });
};

const unbindPullRequest: RegisteredEffect = async (tx, { cohort }) => {
  await tx.query(
    `UPDATE dev_flow.pull_request_verification SET invalidated_at=clock_timestamp(),
       invalidation_reason='replaced' WHERE id=(SELECT current_verified_pull_request_id
       FROM dev_flow.build_cohort WHERE cohort_id=$1) AND invalidated_at IS NULL`, [cohort.id]);
  await tx.query(
    `UPDATE dev_flow.build_cohort SET current_verified_pull_request_id=NULL,updated_at=clock_timestamp()
     WHERE cohort_id=$1`, [cohort.id]);
  return ok({ stage_data: { ...(objectOf(cohort.stage_data) ?? {}), pull_request: null } });
};

const recordMerge: RegisteredEffect = async (tx: SqlExecutor, { cohort, event }) => {
  if (event.kind !== "external_observed") return effectFailure(cohort, "record_merge", "PR observation is required");
  const observation = objectOf(event.observation);
  if (!observation || typeof observation.merged_at !== "string") return effectFailure(cohort, "record_merge", "merge time is missing");
  const current = await tx.query<{ readonly pull_request_id: string }>(
    `SELECT verification.pull_request_id::text FROM dev_flow.build_cohort build
     JOIN dev_flow.pull_request_verification verification ON verification.id=build.current_verified_pull_request_id
     WHERE build.cohort_id=$1`, [cohort.id]);
  if (!current[0]) return effectFailure(cohort, "record_merge", "verified PR is missing");
  await tx.query(
    `INSERT INTO dev_flow.pull_request_merge_closure
       (id,cohort_id,pull_request_id,idempotency_key,merged_at,confirmed_at)
     VALUES (gen_random_uuid(),$1,$2,$3,$4::timestamptz,clock_timestamp())
     ON CONFLICT (cohort_id) DO NOTHING`,
    [cohort.id, current[0].pull_request_id,
      `forge:${current[0].pull_request_id}:${observation.merged_at}`, observation.merged_at]);
  return ok({ stage_data: null });
};

export const registerDevFlowMachine = (registry: StageMachineRegistry,
  effects: Map<string, RegisteredEffect>): void => {
  const stage_type = "delegated_session";
  const guards = {
    pr_matches_cohort: (context: GuardContext) => {
      const detail = prMismatchDetail(context);
      return { holds: detail === null, detail };
    },
    pr_merged_into_base: prMergedIntoBase,
    pr_closed_unmerged: prClosedUnmerged,
    briefs_cover_plan: briefsCoverPlan,
    briefs_acyclic: briefsAcyclic,
  };
  for (const [name, predicate] of Object.entries(guards)) registry.register_guard(stage_type, name as GuardName, predicate);
  for (const [name, effect] of [["bind_pull_request", bindPullRequest], ["unbind_pull_request", unbindPullRequest],
    ["record_merge", recordMerge]] as const) {
    registry.register_effect(stage_type, name as import("../domain/stage-machine").EffectName);
    effects.set(`${stage_type}:${name}`, effect);
  }
  registry.register_observer(stage_type, "pr_watcher" as ObserverName);
};
