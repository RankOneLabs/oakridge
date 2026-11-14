import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import fixture from "../../__fixtures__/v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../../operator-contracts/projections/definition-view";
import { selectStageInspector } from "../../lib/stage-inspector";
import { StageReviewsSection } from "./StageReviewsSection";

const detail = fixture.definition as unknown as OperatorDefinitionDetail;
afterEach(cleanup);

test("an engine review labels its guard as the decision condition", () => {
  const model = selectStageInspector(detail, { kind: "stage", stage: "planning" });
  if (!model || !model.reviews[0]) throw new Error("Missing planning review");
  const review = model.reviews[0];
  render(
    <StageReviewsSection
      model={{
        ...model,
        reviews: [
          {
            ...review,
            review: { ...review.review, by: "engine", when: "published(plan)" },
          },
        ],
      }}
    />,
  );
  expect(screen.getByText(/Decision condition/).textContent).toContain("published(plan)");
  expect(screen.queryByText(/Awaited-decision window/)).toBeNull();
});

test("operator gates emphasise intervention and retain decisions, subjects and feedback", () => {
  const model = selectStageInspector(detail, { kind: "stage", stage: "cohort" });
  if (!model) throw new Error("Missing cohort");
  const { container } = render(<StageReviewsSection model={model} />);
  expect(screen.getAllByText("operator review").length).toBeGreaterThan(0);
  expect(container.querySelectorAll(".or-stage-review").length).toBe(model.reviews.length);
  expect(container.textContent).toContain("effect:");
  expect(container.textContent).toContain("feedback");
});
