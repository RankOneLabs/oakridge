// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { makeBuildBriefFixture } from "../../__fixtures__/read-models";
import { replaceBodyText, selectBodyTextFields } from "../../lib/body-text-edit";
import { BuildBriefViewer } from "./BuildBriefViewer";

afterEach(cleanup);

describe("BuildBriefViewer checked projection", () => {
  test("reads a brief's title and goal", () => {
    const fixture = makeBuildBriefFixture();
    render(<BuildBriefViewer {...fixture} />);
    expect(screen.getByRole("heading", { name: "Build brief review UI" })).toBeTruthy();
    expect(screen.getByText("Make the brief reviewable.")).toBeTruthy();
  });

  test("shows files and acceptance criteria from the checked body", () => {
    const fixture = makeBuildBriefFixture();
    render(<BuildBriefViewer {...fixture} />);
    expect(within(screen.getByTestId("or-brief-files_in_scope")).getByText("kbbl/core/pwa/oakridge")).toBeTruthy();
    expect(within(screen.getByTestId("or-brief-acceptance_criteria")).getByText("Operator can approve the artifact.")).toBeTruthy();
  });

  test("allows checked text replacement in nested list and record atoms", () => {
    const fixture = makeBuildBriefFixture();
    const fields = selectBodyTextFields(fixture.body);
    const file = fields.find((field) => field.label === "files_in_scope / 1");
    const rationale = fields.find((field) => field.label === "decisions_made / 1 / rationale");
    expect([file?.value, rationale?.value]).toEqual(["kbbl/core/pwa/oakridge", "It is proven."]);
    if (!file || !rationale) throw new Error("Expected editable checked atoms");
    const editedFile = replaceBodyText(fixture.body, file.path, "kbbl/core/pwa/oakridge/viewers");
    const edited = editedFile && replaceBodyText(editedFile, rationale.path, "It preserves proven behavior.");
    expect(selectBodyTextFields(edited ?? fixture.body).filter((field) =>
      field.label === file.label || field.label === rationale.label).map((field) => field.value))
      .toEqual(["kbbl/core/pwa/oakridge/viewers", "It preserves proven behavior."]);
  });
});
