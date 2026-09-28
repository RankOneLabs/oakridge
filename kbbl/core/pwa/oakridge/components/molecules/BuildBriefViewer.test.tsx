// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BuildBriefViewer } from "./BuildBriefViewer";

const body = {
  cohort_id: "brief-ui",
  repository_key: "oakridge",
  title: "Build brief review UI",
  depends_on: [],
  goal: "Make the brief reviewable.",
  files_in_scope: ["kbbl/core/pwa/oakridge"],
  decisions_made: [{ decision: "Reuse v1", rationale: "It is proven." }],
  approaches_rejected: [],
  acceptance_criteria: ["Operator can approve the artifact."],
  next_action: "Open the brief artifact.",
};

afterEach(cleanup);

describe("BuildBriefViewer", () => {
  test("offers registered atom editing and submits an RFC-6901 anchor", () => {
    const onEdit = vi.fn();
    render(<BuildBriefViewer body={body} edit={{ enabled: true, isPending: false, onEdit }} />);

    fireEvent.click(screen.getByText("Make the brief reviewable."));
    const input = screen.getByDisplayValue("Make the brief reviewable.");
    fireEvent.change(input, { target: { value: "Make every brief reviewable." } });
    fireEvent.blur(input);

    expect(onEdit).toHaveBeenCalledWith(
      "/goal",
      "Make the brief reviewable.",
      "Make every brief reviewable.",
    );
  });

  test("edits nested array and object atoms", () => {
    const onEdit = vi.fn();
    render(<BuildBriefViewer body={body} edit={{ enabled: true, isPending: false, onEdit }} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit files in scope/0" }));
    const fileInput = screen.getByDisplayValue("kbbl/core/pwa/oakridge");
    fireEvent.change(fileInput, { target: { value: "kbbl/core/pwa/oakridge/viewers" } });
    fireEvent.blur(fileInput);

    fireEvent.click(screen.getByRole("button", { name: "Edit decisions made/0/rationale" }));
    const rationaleInput = screen.getByDisplayValue("It is proven.");
    fireEvent.change(rationaleInput, { target: { value: "It preserves proven behavior." } });
    fireEvent.blur(rationaleInput);

    expect(onEdit).toHaveBeenNthCalledWith(1, "/files_in_scope/0", "kbbl/core/pwa/oakridge", "kbbl/core/pwa/oakridge/viewers");
    expect(onEdit).toHaveBeenNthCalledWith(2, "/decisions_made/0/rationale", "It is proven.", "It preserves proven behavior.");
  });
});
