import type { GradeAnswer } from "./observation";

/** Normalization is opt-in; policy versions never rewrite recorded answers. */
export interface DecisionPolicy {
  readonly policy_id: string;
  readonly policy_version: string;
  normalize(answer: GradeAnswer): number | null;
}

import type { ItemOccurrenceId, GradeObservationId, QuestionId } from "../domain/identity";
import type { GradingSupportRow } from "./eligibility";
import { isCriterionItemKind } from "./question";
import { canonicalJson } from "canonical-json";

/** Input fields mirror captured occurrences, explicit relations and immutable observations. */
export interface CompositeItem {
  readonly occurrence_id: ItemOccurrenceId;
  readonly revision_id: string;
  readonly stage: string;
  readonly artifact_kind: string;
  readonly item_kind: string;
  readonly logical_item_id: string | null;
  readonly definition_id: string;
  readonly artifact_schema_version: string;
  readonly recorded_at: string;
}
export interface CompositeRelation {
  readonly relation_id: string;
  readonly source_occurrence_id: string | null;
  readonly target_occurrence_id: string | null;
  readonly source_logical_item_id: string | null;
  readonly target_logical_item_id: string | null;
  readonly type: string;
  readonly asserted_by: string;
}
export interface CompositeJudgment {
  readonly observation_id: GradeObservationId;
  readonly subject_occurrence_id: ItemOccurrenceId;
  readonly execution_id: string;
  readonly evidence_set_id: string;
  readonly question_id: QuestionId;
  readonly question_version: string;
  readonly evaluator_definition_id: string;
  readonly evaluator: { readonly kind: string; readonly provider: string; readonly model: string | null;
    readonly config_digest: string; readonly runtime_revision: string };
  readonly answer: GradeAnswer;
  readonly supersedes_observation_id: GradeObservationId | null;
  readonly recorded_at: string;
}
export interface CompositeInput {
  readonly criterion: CompositeItem;
  readonly run_id: string;
  readonly as_of: string;
  readonly items: readonly CompositeItem[];
  readonly relations: readonly CompositeRelation[];
  readonly judgments: readonly CompositeJudgment[];
  readonly support: readonly GradingSupportRow[];
}
export interface CompositeGap { readonly kind: "no_constituents" | "unmeasured" | "unsupported" | "unready" | "pending" | "failed" | "disagreement";
  readonly occurrence_id: ItemOccurrenceId | null; readonly question_id: QuestionId | null; readonly detail: string }
export interface CompositeConstituent {
  readonly item: CompositeItem;
  readonly membership_relation_ids: readonly string[];
  readonly judgments: readonly CompositeJudgment[];
  readonly support: readonly GradingSupportRow[];
  readonly gaps: readonly CompositeGap[];
  readonly has_disagreement: boolean;
}
export interface CriterionComposite {
  readonly query_version: "criterion-composite/v1";
  readonly criterion: CompositeItem;
  readonly run_id: string;
  readonly as_of: string;
  readonly policy: { readonly id: "explicit-criterion-constituents"; readonly version: "v1" };
  readonly constituents: readonly CompositeConstituent[];
  readonly result: { readonly state: "complete" | "incomplete";
    readonly judgment_counts: readonly { readonly answer: GradeAnswer; readonly count: number }[];
    readonly coverage: { readonly measured: number; readonly expected: number };
    readonly has_disagreement: boolean };
  readonly gaps: readonly CompositeGap[];
}

/** Walk only producer-explicit/human criterion lineage. An item contributes only when it
 * itself points to a reached criterion; prose, artifact residence and inferred links are ignored. */
export function compositeMembers(input: CompositeInput): readonly { readonly item: CompositeItem; readonly relation_ids: readonly string[] }[] {
  const criteria = input.items.filter((item) => isCriterionItemKind(item.item_kind));
  const explicit = input.relations.filter((relation) => ["producer_explicit", "human"].includes(relation.asserted_by));
  const reached = new Set<string>([input.criterion.occurrence_id]);
  const lineage = new Set<string>();
  const endpoint = (id: string | null, logical: string | null, item: CompositeItem) => id === item.occurrence_id
    || (logical !== null && logical === item.logical_item_id);
  let changed = true;
  while (changed) {
    changed = false;
    for (const relation of explicit.filter((row) => ["derived_from", "same_as", "supersedes"].includes(row.type))) {
      const sources = criteria.filter((item) => endpoint(relation.source_occurrence_id, relation.source_logical_item_id, item));
      const targets = criteria.filter((item) => endpoint(relation.target_occurrence_id, relation.target_logical_item_id, item));
      if (![...sources, ...targets].some((item) => reached.has(item.occurrence_id))) continue;
      if (!sources.length || !targets.length) continue;
      lineage.add(relation.relation_id);
      for (const item of [...sources, ...targets]) if (!reached.has(item.occurrence_id)) { reached.add(item.occurrence_id); changed = true; }
    }
  }
  const referred = input.items.filter((item) => !isCriterionItemKind(item.item_kind)).flatMap((item) => {
    const links = explicit.filter((relation) => ["assesses", "derived_from"].includes(relation.type)
      && endpoint(relation.source_occurrence_id, relation.source_logical_item_id, item)
      && criteria.some((criterion) => reached.has(criterion.occurrence_id)
        && endpoint(relation.target_occurrence_id, relation.target_logical_item_id, criterion)));
    return links.length ? [{ item, relation_ids: [...lineage, ...links.map((row) => row.relation_id)].sort() }] : [];
  });
  // Version policy: the latest captured revision per explicit logical item *within a stage*
  // contributes. Path-only items have no asserted cross-revision identity and remain separate.
  const selected = new Map<string, typeof referred[number]>();
  for (const member of referred.sort((a, b) => a.item.recorded_at.localeCompare(b.item.recorded_at)
    || a.item.revision_id.localeCompare(b.item.revision_id) || a.item.occurrence_id.localeCompare(b.item.occurrence_id))) {
    const key = member.item.logical_item_id ? `${member.item.stage}\0${member.item.artifact_kind}\0${member.item.logical_item_id}` : member.item.occurrence_id;
    selected.set(key, member);
  }
  return [...selected.values()].sort((a, b) => a.item.occurrence_id.localeCompare(b.item.occurrence_id));
}

function judgmentValue(answer: GradeAnswer): string {
  const value = canonicalJson(answer.state === "answered" ? { kind: answer.kind, state: answer.state, value: answer.value }
    : { kind: answer.kind, state: answer.state });
  if (!value.ok) throw new Error(value.error.detail);
  return value.value;
}

/** Corrections remove their ancestors from consideration; independent attempts are selected by
 * (recorded_at, observation_id) descending per item/question/version/evaluator. Replays retain
 * immutable identities, so they cannot add another contribution. Historical rows stay readable. */
export function contributingJudgments(judgments: readonly CompositeJudgment[]): readonly CompositeJudgment[] {
  const superseded = new Set(judgments.flatMap((row) => row.supersedes_observation_id ? [row.supersedes_observation_id] : []));
  const selected = new Map<string, CompositeJudgment>();
  for (const row of [...judgments].filter((row) => !superseded.has(row.observation_id))
    .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at) || a.observation_id.localeCompare(b.observation_id))) {
    selected.set(JSON.stringify([row.subject_occurrence_id, row.question_id, row.question_version, row.evaluator_definition_id]), row);
  }
  return [...selected.values()].sort((a, b) => a.observation_id.localeCompare(b.observation_id));
}

export function deriveCriterionComposite(input: CompositeInput): CriterionComposite {
  const constituents: CompositeConstituent[] = compositeMembers(input).map(({ item, relation_ids }) => {
    const judgments = contributingJudgments(input.judgments.filter((row) => row.subject_occurrence_id === item.occurrence_id));
    const support = input.support.filter((row) => row.subject_occurrence_id === item.occurrence_id);
    const gaps: CompositeGap[] = [];
    const gap = (kind: CompositeGap["kind"], detail: string, question_id: QuestionId | null = null) =>
      gaps.push({ kind, occurrence_id: item.occurrence_id, question_id, detail });
    if (!judgments.length) gap("unmeasured", "no contributing observation for item");
    if (!support.some((row) => row.support.state === "supported")) gap("unsupported", "no supported question contract for item");
    for (const row of support.filter((row) => row.support.state === "supported")) {
      if (row.readiness.state === "unready") gap("unready", row.readiness.reason, row.question_id);
      if (row.execution.state === "failed" || row.execution.state === "pending") gap(row.execution.state, "constituent execution " + row.execution.state, row.question_id);
    }
    const answers = new Map<string, Set<string>>();
    for (const row of judgments) {
      const key = JSON.stringify([row.question_id, row.question_version]);
      if (!answers.has(key)) answers.set(key, new Set());
      answers.get(key)!.add(judgmentValue(row.answer));
    }
    const has_disagreement = [...answers.values()].some((values) => values.size > 1);
    if (has_disagreement) gap("disagreement", "evaluators returned conflicting judgments for the same question version");
    return { item, membership_relation_ids: relation_ids, judgments, support, gaps, has_disagreement };
  });
  const acrossItems = new Map<string, Set<string>>();
  for (const member of constituents) for (const row of member.judgments) {
    const key = JSON.stringify([row.question_id, row.question_version]);
    if (!acrossItems.has(key)) acrossItems.set(key, new Set());
    acrossItems.get(key)!.add(judgmentValue(row.answer));
  }
  const conflictingPins = new Set([...acrossItems].filter(([, values]) => values.size > 1).map(([key]) => key));
  const parts = constituents.map((member): CompositeConstituent => {
    const conflicting = member.judgments.some((row) => conflictingPins.has(JSON.stringify([row.question_id, row.question_version])));
    if (!conflicting || member.has_disagreement) return member;
    return { ...member, has_disagreement: true, gaps: [...member.gaps, { kind: "disagreement", occurrence_id: member.item.occurrence_id,
      question_id: null, detail: "constituents have differing judgments under the same question version" }] };
  });
  const counts = new Map<string, { answer: GradeAnswer; count: number }>();
  for (const member of parts) for (const row of member.judgments) {
    const key = judgmentValue(row.answer), existing = counts.get(key);
    counts.set(key, { answer: existing?.answer ?? row.answer, count: (existing?.count ?? 0) + 1 });
  }
  const gaps: CompositeGap[] = parts.flatMap((row) => row.gaps);
  if (!constituents.length) gaps.push({ kind: "no_constituents", occurrence_id: null, question_id: null, detail: "criterion has no explicitly referring items" });
  return { query_version: "criterion-composite/v1", criterion: input.criterion, run_id: input.run_id, as_of: input.as_of,
    policy: { id: "explicit-criterion-constituents", version: "v1" }, constituents: parts, gaps,
    result: { state: gaps.length ? "incomplete" : "complete", judgment_counts: [...counts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, row]) => row),
      coverage: { measured: constituents.filter((row) => row.judgments.length > 0).length, expected: constituents.length },
      has_disagreement: parts.some((row) => row.has_disagreement) } };
}
