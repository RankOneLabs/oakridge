/**
 * The purge's selection rule, tested as the pure transform it is. The
 * deletion itself is `deleteEpicCascade`, covered against a real database in
 * core/db/__tests__/epics.test.ts.
 */

import { describe, expect, test } from "bun:test";

import type { Epic } from "../core/db/epics";
import type { RuntimeModelSelection } from "../core/runtime";
import { isLegacyEpic, selectPurgeableEpics } from "./purge-legacy-epics";

function epic(
  id: string,
  status: Epic["status"],
  planner: RuntimeModelSelection,
  worker: RuntimeModelSelection,
): Epic {
  return {
    id,
    spec_id: `spec-${id}`,
    project_id: "proj",
    title: id,
    status,
    current_stage: "build",
    planner_model_selection: planner,
    worker_model_selection: worker,
    created_at: "2026-07-01T00:00:00.000Z",
  };
}

const CURRENT_PLANNER: RuntimeModelSelection = {
  runtime: "codex",
  model: "gpt-5.6-sol",
  effort: "xhigh",
};
const CURRENT_WORKER: RuntimeModelSelection = {
  runtime: "claude-code",
  model: "sonnet",
  effort: "high",
};

describe("isLegacyEpic", () => {
  test("an epic on current ids is kept", () => {
    expect(isLegacyEpic(epic("e", "active", CURRENT_PLANNER, CURRENT_WORKER))).toBe(false);
  });

  test("a model the agent stopped advertising makes the epic legacy", () => {
    // codex-acp 1.11.0 dropped gpt-5.4-mini.
    const worker = { runtime: "codex", model: "gpt-5.4-mini" } as const;
    expect(isLegacyEpic(epic("e", "active", CURRENT_PLANNER, worker))).toBe(true);
  });

  test("an effort the agent stopped advertising makes the epic legacy", () => {
    const planner = { runtime: "codex", model: "gpt-5.6-sol", effort: "minimal" } as const;
    expect(isLegacyEpic(epic("e", "active", planner, CURRENT_WORKER))).toBe(true);
  });

  test("no effort override is not a legacy selection", () => {
    const planner = { runtime: "codex", model: "gpt-5.6-sol", effort: null } as const;
    expect(isLegacyEpic(epic("e", "active", planner, CURRENT_WORKER))).toBe(false);
  });
});

describe("selectPurgeableEpics", () => {
  const stale = { runtime: "claude-code", model: "claude-opus-4-8" } as const;
  const epics = [
    epic("live-ok", "active", CURRENT_PLANNER, CURRENT_WORKER),
    epic("live-stale", "active", stale, CURRENT_WORKER),
    epic("pending-stale", "pending", stale, CURRENT_WORKER),
    epic("archived-stale", "archived", stale, CURRENT_WORKER),
  ];

  test("by default only epics that can still dispatch are purged", () => {
    expect(selectPurgeableEpics(epics, false).map((e) => e.id)).toEqual([
      "live-stale",
      "pending-stale",
    ]);
  });

  test("--include-archived reaches inert history too", () => {
    expect(selectPurgeableEpics(epics, true).map((e) => e.id)).toEqual([
      "live-stale",
      "pending-stale",
      "archived-stale",
    ]);
  });
});
