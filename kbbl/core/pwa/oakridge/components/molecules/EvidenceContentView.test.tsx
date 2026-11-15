// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { AssessmentFinding } from "../../lib/assessment";
import { EvidenceContentView } from "./EvidenceContentView";

afterEach(cleanup);

const finding = (evidence: AssessmentFinding["evidence"]): AssessmentFinding =>
  ({ item_path: "/findings/0", task_ids: [], status: "met", evidence, description: "Covers the launcher" });

test("assessment finding evidence renders one line per reference with its kind, ref and detail", () => {
  render(<EvidenceContentView content={{ kind: "assessment_finding", value: finding([
    { kind: "file", ref: "scripts/oakridge-lan", detail: "reads .env before preflight" },
    { kind: "test", ref: "lan-launcher.test.ts", detail: null },
  ]) }} />);
  const lines = screen.getAllByTestId("or-evidence-ref");
  // The detail is set apart by margin, not a space, so compare the visible parts in order.
  expect(lines.map((line) => line.textContent?.replace(/\s+/g, ""))).toEqual(["filescripts/oakridge-lanreads.envbeforepreflight", "testlan-launcher.test.ts"]);
});

test("assessment finding evidence is not laid out as per-field sections", () => {
  render(<EvidenceContentView content={{ kind: "assessment_finding", value: finding([{ kind: "file", ref: "a.ts", detail: "x" }]) }} />);
  expect(screen.queryByText("Kind")).toBeNull();
});

test("assessment finding with no evidence says none was cited", () => {
  render(<EvidenceContentView content={{ kind: "assessment_finding", value: finding([]) }} />);
  expect(screen.getByText("No evidence cited.")).toBeTruthy();
});

test("long evidence references wrap inside the panel", () => {
  render(<EvidenceContentView content={{ kind: "assessment_finding", value: finding([{ kind: "file", ref: "a/".repeat(80) + "file.ts", detail: "x".repeat(200) }]) }} />);
  const line = screen.getByTestId("or-evidence-ref");
  expect([line.classList.contains("break-words"), line.querySelector("code")?.classList.contains("break-all")]).toEqual([true, true]);
});
