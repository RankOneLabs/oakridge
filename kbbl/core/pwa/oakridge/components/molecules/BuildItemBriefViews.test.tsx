// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import body from "../../lib/__fixtures__/build-items-brief.json";
import { parseBuildBrief } from "../../lib/build-brief";
import type { BuildResult } from "../../lib/build-result";
import { BuildResultViewer } from "./BuildResultViewer";
import { EvidenceContentView } from "./EvidenceContentView";
const value = parseBuildBrief({ ...body, build_items: body.build_items.map((item) => ({ ...item, decision_ids: [...item.decision_ids, "missing-decision"] })) });
if (value?.shape !== "build_items") throw new Error("invalid fixture");
const brief = value;
const result: BuildResult = { commit_sha: "abc", repository_key: null, summary: "Built", changed_files: [], tests: { passed: 1, failed: 0, output: null, summary: null, cargo_test_output: null }, issues: [], delegated_session_metadata: null };
const source = { run_id: "run", revision_id: "v2|artifact|run|briefs|brief:exact-brief", label: "pwa", as_of: "now" };
afterEach(cleanup);
test.each(["result", "evidence"])("%s displays build-item details with task navigation and exact brief grade address", (view) => {
  const onOpenTask = vi.fn(), onOpenItem = vi.fn();
  const review = { source, onOpenTask, onOpenItem };
  render(view === "result" ? <BuildResultViewer result={result} brief={{ kind: "found", value: brief }} cohortLabel="pwa" briefReview={review} /> : <EvidenceContentView content={{ kind: "brief", value: brief }} {...review} />);
  const section = within(screen.getByTestId("or-brief-build-items"));
  expect(section.getByText("Build items")).toBeTruthy();
  for (const text of ["B1", "Review build items", "decision-new: Add a compact trace section.", "missing-decision: Unresolved", "Run PWA tests", "Verification expectations"]) expect(section.getByText(text)).toBeTruthy();
  fireEvent.click(section.getByRole("button", { name: "Open task criterion-brief" }));
  expect(onOpenTask).toHaveBeenCalledWith("criterion-brief");
  fireEvent.click(section.getByRole("button", { name: "Open grading at /build_items/0" }));
  expect(onOpenItem).toHaveBeenCalledWith({ source_revision_id: "exact-brief", item_path: "/build_items/0" });
  expect(screen.queryByText("Contributions to spec tasks")).toBeNull();
});
