import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertEpic } from "../../db/epics";
import { insertPlan } from "../../db/plans";
import { insertCohort } from "../../db/cohorts";
import { insertBrief } from "../../db/briefs";
import { buildSlotsForBrief, resolveEpicRoutingOverride } from "./dispatcher";
import { loadPrompt, renderPrompt } from "./prompt-loader";
import type { Epic } from "../../types/task-tracker";

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const EPIC_ID = "epic-1";
const PLAN_ID = "plan-1";
const COHORT_ID = "cohort-1";
const BRIEF_ID = "brief-1";
// sanitizeForName("My Great Epic Feature", "epic-1") → "my_great_epic_feature"
const EPIC_TITLE = "My Great Epic Feature";
const EPIC_SLUG = "my_great_epic_feature";

let db: Database;

beforeEach(() => {
  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/tmp/repo" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "S" });
  insertEpic(db, {
    id: EPIC_ID,
    spec_id: SPEC_ID,
    project_id: PROJECT_ID,
    title: EPIC_TITLE,
    status: "active",
    current_stage: "build",
  });
  insertPlan(db, { id: PLAN_ID, spec_id: SPEC_ID });
  insertCohort(db, { id: COHORT_ID, plan_id: PLAN_ID, title: "C", position: 1 });
  insertBrief(db, {
    id: BRIEF_ID,
    cohort_id: COHORT_ID,
    goal: "Do the thing",
    files_in_scope: [],
    decisions_made: [],
    approaches_rejected: [],
    next_action: "Start here",
  });
});

afterEach(() => {
  db.close();
});

function makeEpic(overrides: Partial<Epic> = {}): Epic {
  return {
    id: "e1",
    spec_id: "s1",
    project_id: "p1",
    title: "T",
    status: "active",
    current_stage: "build",
    planner_runtime: null,
    planner_model: null,
    build_runtime: null,
    build_model: null,
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("resolveEpicRoutingOverride — knob selection and partial fallthrough", () => {
  test("null epic → undefined", () => {
    expect(resolveEpicRoutingOverride(null, "build")).toBeUndefined();
    expect(resolveEpicRoutingOverride(null, "plan_writer")).toBeUndefined();
  });

  test("build stage with full build knob → build override", () => {
    const result = resolveEpicRoutingOverride(
      makeEpic({ build_runtime: "codex", build_model: "codex-custom" }),
      "build",
    );
    expect(result).toEqual({ runtime: "codex", model: "codex-custom" });
  });

  test("planner stages with full planner knob → planner override", () => {
    const epic = makeEpic({ planner_runtime: "claude-code", planner_model: "claude-opus-4-9" });
    for (const stageName of ["spec_analyzer", "plan_writer", "brief_writer", "assessor"]) {
      expect(resolveEpicRoutingOverride(epic, stageName)).toEqual({
        runtime: "claude-code",
        model: "claude-opus-4-9",
      });
    }
  });

  test("build stage ignores planner knob", () => {
    const epic = makeEpic({ planner_runtime: "codex", planner_model: "p-model", build_runtime: null, build_model: null });
    expect(resolveEpicRoutingOverride(epic, "build")).toBeUndefined();
  });

  test("planner stage ignores build knob", () => {
    const epic = makeEpic({ build_runtime: "codex", build_model: "b-model", planner_runtime: null, planner_model: null });
    expect(resolveEpicRoutingOverride(epic, "plan_writer")).toBeUndefined();
  });

  test("partial build knob (runtime set, model null) → undefined (falls through)", () => {
    const epic = makeEpic({ build_runtime: "codex", build_model: null });
    expect(resolveEpicRoutingOverride(epic, "build")).toBeUndefined();
  });

  test("partial planner knob (model set, runtime null) → undefined (falls through)", () => {
    const epic = makeEpic({ planner_runtime: null, planner_model: "some-model" });
    expect(resolveEpicRoutingOverride(epic, "plan_writer")).toBeUndefined();
  });

  test("unknown stage name with full knobs → undefined", () => {
    const epic = makeEpic({ build_runtime: "codex", build_model: "b", planner_runtime: "claude-code", planner_model: "p" });
    expect(resolveEpicRoutingOverride(epic, "future-stage")).toBeUndefined();
  });
});

describe("buildSlotsForBrief — EPIC_BRANCH slot", () => {
  test("EPIC_BRANCH is epic/<slug> from sanitizeForName(epic.title, epic.id)", () => {
    const slots = buildSlotsForBrief(db, BRIEF_ID, "http://kbbl");
    expect(slots.EPIC_BRANCH).toBe(`epic/${EPIC_SLUG}`);
  });

  test("rendered build prompt contains --base epic/<slug>", () => {
    const slots = buildSlotsForBrief(db, BRIEF_ID, "http://kbbl");
    const template = loadPrompt("build.md");
    const rendered = renderPrompt(template, slots);
    expect(rendered).toContain(`--base epic/${EPIC_SLUG}`);
  });

  test("rendered build prompt has --base immediately before --title", () => {
    const slots = buildSlotsForBrief(db, BRIEF_ID, "http://kbbl");
    const template = loadPrompt("build.md");
    const rendered = renderPrompt(template, slots);
    expect(rendered).toContain(`--base epic/${EPIC_SLUG} --title`);
  });
});
