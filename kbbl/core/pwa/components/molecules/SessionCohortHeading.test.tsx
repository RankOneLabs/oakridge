import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionCohortHeading } from "./SessionCohortHeading";

describe("SessionCohortHeading", () => {
  it("does not repeat the unit id when it is the fallback title", () => {
    render(<SessionCohortHeading title={null} secondaryId="cohort-a" repositoryKey={null} />);

    expect(screen.getAllByText("cohort-a")).toHaveLength(1);
  });

  it("shows the unit id alongside a distinct cohort title", () => {
    render(<SessionCohortHeading title="Web client" secondaryId="cohort-a" repositoryKey="oakridge" />);

    expect(screen.getByText("Web client")).toBeTruthy();
    expect(screen.getByText("cohort-a")).toBeTruthy();
    expect(screen.getByText("oakridge")).toBeTruthy();
  });

  it("omits a secondary id when the subgroup has no useful operator-facing id", () => {
    render(<SessionCohortHeading title="Plan the work" repositoryKey={null} />);

    expect(screen.getByText("Plan the work")).toBeTruthy();
    expect(document.querySelector(".session-cohort-heading__id")).toBeNull();
  });
});
