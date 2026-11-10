// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ArtifactSource } from "../artifact-types";
import { compositeId } from "../adapters/core";
import { BuildBriefViewer } from "../components/molecules/BuildBriefViewer";
import { PlanViewer } from "../components/molecules/PlanViewer";
import { TasksViewer } from "../components/molecules/TasksViewer";
import brief from "../lib/__fixtures__/id-linked-brief.json";

afterEach(cleanup);
const source = (kind: string): ArtifactSource => ({ run_id: "run-1", label: null, as_of: "2026-11-01T00:00:00Z",
  revision_id: compositeId({ kind: "artifact", runId: "run-1", unitId: "unit", name: `${kind}:unit:${kind}:1` }) });
const contribution = { id: "T1", text: "This cohort's share of the organization task", decision_ids: [] };
const cohort = (id: string, depends_on: string[] = []) => ({ id, title: id, repository_key: "oakridge", scope: "One contribution",
  files_in_scope: [], decisions: [], depends_on, acceptance_criteria: [contribution] });

test("a spec task opens grading at its exact task-list revision and array position", () => {
  const open = vi.fn();
  render(<TasksViewer source={source("tasks")} onOpenItem={open} body={{ tasks: [
    { id: "T1", description: "Organization model", requirement_ids: ["R1"] },
    { id: "T2", description: "Organization UI", requirement_ids: ["R2"] }] }} />);
  fireEvent.click(screen.getAllByTestId("or-grade-item")[1]!);
  expect(open).toHaveBeenCalledWith({ source_revision_id: "unit:tasks:1", item_path: "/tasks/1" });
});

test("reordering plan cohorts for display never readdresses a contribution or its shared task", () => {
  const open = vi.fn();
  render(<PlanViewer source={source("plan")} onOpenItem={open} body={{ summary: "Shared task", cohorts: [cohort("api", ["core"]), cohort("core")],
    dependency_order: ["core", "api"], acceptance_criteria: [], scope: { in_scope: [], out_of_scope: [] }, risks: [] }} />);
  const cards = screen.getAllByTestId("or-plan-cohort");
  expect(cards.map((card) => card.getAttribute("data-cohort-id"))).toEqual(["core", "api"]);
  fireEvent.click(within(cards[0]!).getByTestId("or-grade-item"));
  fireEvent.click(within(cards[1]!).getByTestId("or-grade-item"));
  expect(open.mock.calls.map(([selection]) => selection)).toEqual([
    { source_revision_id: "unit:plan:1", item_path: "/cohorts/1/acceptance_criteria/0" },
    { source_revision_id: "unit:plan:1", item_path: "/cohorts/0/acceptance_criteria/0" }]);
});

test("a brief contribution opens its own grading evidence rather than the plan's or the spec task's", () => {
  const open = vi.fn();
  render(<BuildBriefViewer source={source("brief")} onOpenItem={open} body={brief} />);
  fireEvent.click(screen.getAllByTestId("or-grade-item")[0]!);
  expect(open).toHaveBeenCalledWith({ source_revision_id: "unit:brief:1", item_path: "/acceptance_criteria/0" });
});
