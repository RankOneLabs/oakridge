import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SessionUnitHeading } from "./SessionUnitHeading";

describe("SessionUnitHeading", () => {
  it("shows the unit's label", () => {
    render(<SessionUnitHeading title="Plan the work" />);
    expect(screen.getByText("Plan the work")).toBeTruthy();
  });
});
