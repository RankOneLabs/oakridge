// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BuildResultReview } from "./BuildResultReview";
import body from "../../lib/__fixtures__/build-items-brief.json";
import { parseBuildBrief } from "../../lib/build-brief";
const briefSource = { run_id: "run", revision_id: "v2|artifact|run|briefs/pwa|brief:original", label: "pwa", as_of: "2026-10-01" };
vi.mock("../../hooks/useCohortArtifact", () => ({ useCohortArtifact: () => ({ kind: "found", value: parseBuildBrief(body), source: briefSource }) }));
afterEach(cleanup);
test("production result review forwards task navigation and the selected brief grading identity", () => {
  const onOpenTask = vi.fn(), onOpenItem = vi.fn();
  render(<BuildResultReview body={{ head_sha: "abc", summary: "Built", changed_files: [], tests: { passed: 1, failed: 0 }, known_issues: [] }} source={{ ...briefSource, revision_id: "v2|artifact|run|implementation/pwa|build_result:result" }} onOpenTask={onOpenTask} onOpenItem={onOpenItem} />);
  fireEvent.click(screen.getByRole("button", { name: "Open task criterion-brief" }));
  expect(onOpenTask).toHaveBeenCalledWith("criterion-brief");
  fireEvent.click(screen.getByRole("button", { name: "Open grading at /build_items/0" }));
  expect(onOpenItem).toHaveBeenCalledWith({ source_revision_id: "original", item_path: "/build_items/0" });
});
