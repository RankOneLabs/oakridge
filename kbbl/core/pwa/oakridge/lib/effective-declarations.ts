import type { OperatorWorker, OperatorParsedReview, OperatorParsedReviewDecision, OperatorDecisionSetUse, OperatorAuthoredReview } from "../operator-contracts/core-client/core-types";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";

export interface TemplateSource { template: string }
export interface DecisionSetSource { set: string; overrides: OperatorDecisionSetUse["overrides"] | null; rename: OperatorDecisionSetUse["rename"] | null }
export interface EffectiveWorker { stage: string; key: string; worker: OperatorWorker; source: TemplateSource | null }
export interface EffectiveDecision { key: string; decision: OperatorParsedReviewDecision; source: DecisionSetSource | null }
export interface EffectiveReview { stage: string; key: string; review: OperatorParsedReview; source: TemplateSource | null; decisions: EffectiveDecision[] }

function selectTemplateSource(entry: OperatorWorker | OperatorAuthoredReview | { template: string } | undefined): TemplateSource | null {
  return entry && "template" in entry ? { template: entry.template } : null;
}
function selectDecisionSource(entry: OperatorAuthoredReview | undefined): DecisionSetSource | null {
  if (!entry || "template" in entry) return null;
  const decisions = entry.decisions;
  if (typeof decisions.set !== "string") return null;
  const use = decisions as OperatorDecisionSetUse;
  return { set: use.set, overrides: use.overrides ?? null, rename: use.rename ?? null };
}

export function selectEffectiveWorkers(detail: OperatorDefinitionDetail): EffectiveWorker[] {
  return Object.entries(detail.workflow.stages).flatMap(([stage, authored]) =>
    Object.keys(authored.workers).flatMap((key) => {
      const worker = detail.effective_workflow.stages[stage]?.workers[key];
      return worker ? [{ stage, key, worker, source: selectTemplateSource(authored.workers[key]) }] : [];
    }));
}
export function selectEffectiveReviews(detail: OperatorDefinitionDetail): EffectiveReview[] {
  return Object.entries(detail.workflow.stages).flatMap(([stage, authored]) =>
    Object.keys(authored.reviews ?? {}).flatMap((key) => {
      const review = detail.effective_workflow.stages[stage]?.reviews?.[key];
      if (!review) return [];
      const entry = authored.reviews?.[key];
      const source = selectDecisionSource(entry);
      return [{ stage, key, review, source: selectTemplateSource(entry),
        decisions: Object.entries(review.decisions).map(([key, decision]) => ({ key, decision, source })) }];
    }));
}
