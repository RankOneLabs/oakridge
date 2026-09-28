import { describe, expect, it } from "vitest";
import { adaptDependencies, deriveCohortDependencies } from "./PlanViewer";

describe("PlanViewer dependency adaptation", () => {
  it("derives directed DAG edges from each cohort's depends_on list", () => {
    expect(deriveCohortDependencies([
      { id: "foundation", depends_on: [] },
      { id: "api", depends_on: ["foundation"] },
      { id: "ui", depends_on: ["foundation", "api"] },
    ])).toMatchObject([
      { from_cohort_id: "foundation", to_cohort_id: "api" },
      { from_cohort_id: "foundation", to_cohort_id: "ui" },
      { from_cohort_id: "api", to_cohort_id: "ui" },
    ]);
  });

  it("supports explicit dependency edge descriptors", () => {
    expect(adaptDependencies([{ from: "spec", to: "build" }])).toMatchObject([
      { from_cohort_id: "spec", to_cohort_id: "build" },
    ]);
  });
});
