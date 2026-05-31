import { describe, expect, test } from "bun:test";

import {
  blankTaskDraftForm,
  isBlankTaskDraftForm,
  sanitizeTaskDraftForm,
  taskDraftFormToPayload,
} from "./taskDraft";

describe("task draft helpers", () => {
  test("recognizes the default blank form as blank", () => {
    expect(isBlankTaskDraftForm(blankTaskDraftForm())).toBe(true);
  });

  test("fills default model pools when the form leaves them blank", () => {
    const form = blankTaskDraftForm("code");
    const sanitized = sanitizeTaskDraftForm({
      ...form,
      name: "dashboard_local_code",
      artifact_filename: "solution.py",
      seed_content: "def f(): ...",
      brief: {
        target_spec: "implement something",
        success_criteria: ["passes tests"],
        constraints: [],
      },
    });
    const payload = taskDraftFormToPayload(sanitized);
    expect("error" in payload).toBe(false);
    if (!("error" in payload)) {
      expect(payload.model_pool[0]).toBe("claude-sonnet-4-5");
      expect(payload.frame_pool[0]).toBe("type-safety");
    }
  });

  test("drops blank brief entries during sanitization", () => {
    const sanitized = sanitizeTaskDraftForm({
      ...blankTaskDraftForm(),
      name: "dashboard_local_note",
      artifact_filename: "draft.md",
      brief: {
        target_spec: "write a note",
        success_criteria: ["", "covers the point", " "],
        constraints: ["", "keep it short"],
      },
    });
    expect(sanitized.brief.success_criteria).toEqual(["covers the point"]);
    expect(sanitized.brief.constraints).toEqual(["keep it short"]);
  });
});
