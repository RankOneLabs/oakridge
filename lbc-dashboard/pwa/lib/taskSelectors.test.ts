import { describe, expect, test } from "bun:test";

import type { GraderConfigDraft, GraderSummary, TaskDetail, TaskSummary } from "../../src/contracts";
import { taskStateLabels, taskSummaryStateLabels } from "./taskSelectors";

const graders: GraderSummary[] = [
  {
    key: "prose_substrate_thesis",
    label: "Brief judge",
    supported_artifact_types: ["prose"],
    capabilities: ["brief-criteria"],
    source: "builtin",
    config_required: false,
    config_schema: null,
  },
];

const graderConfigs: GraderConfigDraft[] = [
  {
    task_name: "dashboard_local_note",
    grader_key: "prose_substrate_thesis",
    config: { judge_model: "claude-sonnet-4-5" },
  },
];

describe("task selectors", () => {
  test("labels builtin tasks as available to launch", () => {
    const task: TaskSummary = {
      name: "prose_substrate_thesis",
      artifact_type: "prose",
      artifact_filename: "thesis.md",
      has_grader: true,
      grader_key: "prose_substrate_thesis",
      source: "builtin",
    };
    expect(taskSummaryStateLabels(task, graders, graderConfigs)).toEqual([
      "Built-in",
      "Available to launch",
    ]);
  });

  test("labels configured local tasks as saved and configured", () => {
    const task: TaskSummary = {
      name: "dashboard_local_note",
      artifact_type: "prose",
      artifact_filename: "draft.md",
      has_grader: true,
      grader_key: "prose_substrate_thesis",
      source: "local",
    };
    expect(taskSummaryStateLabels(task, graders, graderConfigs)).toEqual([
      "Saved",
      "Grader configured",
    ]);
  });

  test("labels local tasks without graders as saved and no grader", () => {
    const task: TaskDetail = {
      name: "dashboard_local_note",
      artifact_type: "prose",
      artifact_filename: "draft.md",
      seed_content: "# seed",
      brief: {
        target_spec: "write a note",
        success_criteria: ["covers the point"],
        constraints: ["keep it short"],
      },
      model_pool: ["claude-sonnet-4-5"],
      frame_pool: [],
      grader: { kind: "none" },
      has_grader: false,
      grader_key: null,
      source: "local",
    };
    expect(taskStateLabels(task, graders, graderConfigs)).toEqual([
      "Saved",
      "No grader",
    ]);
  });
});
