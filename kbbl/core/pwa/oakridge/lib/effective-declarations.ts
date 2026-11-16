import type {
  OperatorWorker,
  OperatorParsedReview,
  OperatorParsedReviewDecision,
  OperatorDecisionSetUse,
  OperatorAuthoredReview,
} from "../operator-contracts/core-client/core-types";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";

export interface TemplateSource {
  template: string;
}
export interface DecisionSetSource {
  set: string;
  overrides: OperatorDecisionSetUse["overrides"] | null;
  rename: OperatorDecisionSetUse["rename"] | null;
}
export interface EffectiveWorker {
  stage: string;
  key: string;
  worker: OperatorWorker;
  source: TemplateSource | null;
}
export interface EffectiveDecision {
  key: string;
  decision: OperatorParsedReviewDecision;
  source: DecisionSetSource | null;
}
export interface EffectiveReview {
  stage: string;
  key: string;
  review: OperatorParsedReview;
  source: TemplateSource | null;
  decisions: EffectiveDecision[];
}

function selectTemplateSource(
  entry:
    | OperatorWorker
    | OperatorAuthoredReview
    | { template: string }
    | undefined,
): TemplateSource | null {
  return entry && "template" in entry ? { template: entry.template } : null;
}
function selectDecisionSource(
  entry: OperatorAuthoredReview | undefined,
): DecisionSetSource | null {
  if (!entry || "template" in entry) return null;
  const decisions = entry.decisions;
  if (typeof decisions.set !== "string") return null;
  const use = decisions as OperatorDecisionSetUse;
  return {
    set: use.set,
    overrides: use.overrides ?? null,
    rename: use.rename ?? null,
  };
}

export function selectEffectiveWorkers(
  detail: OperatorDefinitionDetail,
): EffectiveWorker[] {
  return Object.entries(detail.workflow.stages).flatMap(([stage, authored]) =>
    Object.keys(authored.workers).flatMap((key) => {
      const worker = detail.effective_workflow.stages[stage]?.workers[key];
      return worker
        ? [
            {
              stage,
              key,
              worker,
              source: selectTemplateSource(authored.workers[key]),
            },
          ]
        : [];
    }),
  );
}
export function selectEffectiveReviews(
  detail: OperatorDefinitionDetail,
): EffectiveReview[] {
  return Object.entries(detail.workflow.stages).flatMap(([stage, authored]) =>
    Object.keys(authored.reviews ?? {}).flatMap((key) => {
      const review = detail.effective_workflow.stages[stage]?.reviews?.[key];
      if (!review) return [];
      const entry = authored.reviews?.[key];
      const source = selectDecisionSource(entry);
      return [
        {
          stage,
          key,
          review,
          source: selectTemplateSource(entry),
          decisions: Object.entries(review.decisions).map(
            ([key, decision]) => ({ key, decision, source }),
          ),
        },
      ];
    }),
  );
}

import type {
  StageInspectorModel,
  StageSourceDeclaration,
} from "./stage-inspector";
interface StageSourceInput {
  definition: OperatorDefinitionDetail;
  workers: StageInspectorModel["workers"];
  reviews: StageInspectorModel["reviews"];
}
export function selectStageSources({
  definition,
  workers,
  reviews,
}: StageSourceInput): StageSourceDeclaration[] {
  const authored = definition.workflow;
  const workerTemplates = [
    ...new Set(
      workers.flatMap(({ source }) => (source ? [source.template] : [])),
    ),
  ];
  const reviewTemplates = [
    ...new Set(
      reviews.flatMap(({ source }) => (source ? [source.template] : [])),
    ),
  ];
  const decisionSets = [
    ...new Set(
      reviews.flatMap(({ decisions }) =>
        decisions.flatMap(({ source }) => (source ? [source.set] : [])),
      ),
    ),
  ];
  return [
    ...workerTemplates.flatMap((name): StageSourceDeclaration[] => {
      const declaration =
        "workers" in authored ? authored.workers?.[name] : null;
      return declaration
        ? [
            {
              kind: "template-worker",
              name,
              label: `Worker template ${name}`,
              content: JSON.stringify(declaration, null, 2),
            },
          ]
        : [];
    }),
    ...reviewTemplates.flatMap((name): StageSourceDeclaration[] => {
      const declaration =
        "reviews" in authored ? authored.reviews?.[name] : null;
      return declaration
        ? [
            {
              kind: "template-review",
              name,
              label: `Review template ${name}`,
              content: JSON.stringify(declaration, null, 2),
            },
          ]
        : [];
    }),
    ...decisionSets.flatMap((name): StageSourceDeclaration[] => {
      const declaration =
        "decisions" in authored ? authored.decisions?.[name] : null;
      return declaration
        ? [
            {
              kind: "decision-set",
              name,
              label: `Decision set ${name}`,
              content: JSON.stringify(declaration, null, 2),
            },
          ]
        : [];
    }),
  ];
}

/** A request-changes decision may revise a different artifact than the one reviewed. */
export interface ReviewRevision {
  stage: string;
  review: string;
  decision: string;
  artifact: string;
  workers: string[];
}
export function selectReviewRevisions(
  definition: OperatorDefinitionDetail,
): ReviewRevision[] {
  const workers = selectEffectiveWorkers(definition);
  return selectEffectiveReviews(definition).flatMap((review) =>
    review.decisions
      .filter(({ decision }) => decision.effect === "request_changes")
      .map(({ key, decision }) => {
        const artifact = decision.on ?? review.review.of;
        return {
          stage: review.stage,
          review: review.key,
          decision: key,
          artifact,
          workers: workers
            .filter(
              (entry) =>
                entry.stage === review.stage &&
                entry.worker.produces.includes(artifact) &&
                entry.worker.kind === "agent" &&
                entry.worker.prompts.revise != null,
            )
            .map((entry) => entry.key),
        };
      }),
  );
}
