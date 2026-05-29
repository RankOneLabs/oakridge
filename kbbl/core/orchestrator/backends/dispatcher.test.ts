import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertEpic } from "../../db/epics";
import { insertPlan } from "../../db/plans";
import { insertCohort } from "../../db/cohorts";
import { insertBrief } from "../../db/briefs";
import { createDispatcher } from "./dispatcher";
import type { ExecutionBackend, InputRef, StageRow } from "./interface";

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

function makeCaptureBackend(): { backend: ExecutionBackend; prompts: string[] } {
  const prompts: string[] = [];
  const backend: ExecutionBackend = {
    id: "kbbl_chat",
    async dispatch(_stage: StageRow, _inputRef: InputRef, renderedPrompt: string) {
      prompts.push(renderedPrompt);
      return { session_ref: "fake-sid" };
    },
    async status() {
      return "completed" as const;
    },
  };
  return { backend, prompts };
}

describe("dispatcher build prompt — EPIC_BRANCH slot", () => {
  test("rendered build prompt contains --base epic/<slug>", async () => {
    const { backend, prompts } = makeCaptureBackend();
    const dispatcher = createDispatcher({
      db,
      backends: { kbbl_chat: backend },
      kbblUrl: "http://kbbl",
    });

    await dispatcher.dispatch("build", BRIEF_ID);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`--base epic/${EPIC_SLUG}`);
  });

  test("EPIC_BRANCH slug matches sanitizeForName(epic.title, epic.id)", async () => {
    const { backend, prompts } = makeCaptureBackend();
    const dispatcher = createDispatcher({
      db,
      backends: { kbbl_chat: backend },
      kbblUrl: "http://kbbl",
    });

    await dispatcher.dispatch("build", BRIEF_ID);

    // Verify the exact slug derived from the fixture epic title
    expect(prompts[0]).toContain(`--base epic/${EPIC_SLUG} --title`);
  });
});
