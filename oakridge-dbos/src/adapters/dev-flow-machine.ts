import { repositoriesMatch } from "../domain/pull-request";
import { type JsonValue } from "../domain/primitives";
import type { GuardContext } from "../domain/stage-machine";
import type { ArtifactEnvelope } from "../domain/execution";

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


/** Read-only vocabulary for validating graph fixtures during the cutover.
 * No guard implementation or effect handler is registered here.
 */
export const legacyMachineVocabulary = {
  guards: ["pr_matches_cohort", "pr_merged_into_base", "pr_closed_unmerged", "briefs_cover_plan", "briefs_acyclic"],
  effects: ["bind_pull_request", "unbind_pull_request", "record_merge"],
  observers: ["pr_watcher"],
} as const;
