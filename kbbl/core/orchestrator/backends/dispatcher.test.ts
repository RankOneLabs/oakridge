import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertEpic } from "../../db/epics";
import { insertPlan } from "../../db/plans";
import { insertCohort } from "../../db/cohorts";
import { insertBrief } from "../../db/briefs";
import { buildSlotsForBrief } from "./dispatcher";
import { loadPrompt, renderPrompt } from "./prompt-loader";

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

describe("buildSlotsForBrief — EPIC_BRANCH slot", () => {
  test("EPIC_BRANCH is epic/<slug> from sanitizeForName(epic.title, epic.id)", () => {
    const slots = buildSlotsForBrief(db, BRIEF_ID, "http://kbbl");
    expect(slots.EPIC_BRANCH).toBe(`epic/${EPIC_SLUG}`);
  });

  test("rendered build prompt uses epic/<slug> as the open_pr base", () => {
    const slots = buildSlotsForBrief(db, BRIEF_ID, "http://kbbl");
    const template = loadPrompt("build.md");
    const rendered = renderPrompt(template, slots);
    expect(rendered).toContain(`\`base\` = \`epic/${EPIC_SLUG}\``);
  });

  test("rendered build prompt opens the PR via open_pr against the epic base", () => {
    const slots = buildSlotsForBrief(db, BRIEF_ID, "http://kbbl");
    const template = loadPrompt("build.md");
    const rendered = renderPrompt(template, slots);
    expect(rendered).toContain("mcp__gated-review__open_pr");
    expect(rendered).toContain(`\`base\` = \`epic/${EPIC_SLUG}\`, \`head\``);
  });
});
