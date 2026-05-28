import { describe, expect, test } from "bun:test";
import {
  EPIC_STAGE_TRANSITIONS,
  EPIC_LIFECYCLE_TRANSITIONS,
  applyEpicTransition,
  InvalidTransitionError,
  type EpicState,
} from "../epic-state-machine";

// ─── EPIC_STAGE_TRANSITIONS table ────────────────────────────────────────────

describe("EPIC_STAGE_TRANSITIONS table", () => {
  test("spec -epic_spec_approved→ plan", () => {
    expect(EPIC_STAGE_TRANSITIONS.spec.epic_spec_approved).toBe("plan");
  });
  test("plan -epic_plan_approved→ build", () => {
    expect(EPIC_STAGE_TRANSITIONS.plan.epic_plan_approved).toBe("build");
  });
  test("build -epic_build_done→ assess", () => {
    expect(EPIC_STAGE_TRANSITIONS.build.epic_build_done).toBe("assess");
  });
  test("assess -epic_assess_done→ assess (terminal no-op)", () => {
    expect(EPIC_STAGE_TRANSITIONS.assess.epic_assess_done).toBe("assess");
  });
});

// ─── EPIC_LIFECYCLE_TRANSITIONS table ────────────────────────────────────────

describe("EPIC_LIFECYCLE_TRANSITIONS table", () => {
  test("pending -start→ active", () => {
    expect(EPIC_LIFECYCLE_TRANSITIONS.pending.start).toBe("active");
  });
  test("pending -archive→ archived", () => {
    expect(EPIC_LIFECYCLE_TRANSITIONS.pending.archive).toBe("archived");
  });
  test("active -archive→ archived", () => {
    expect(EPIC_LIFECYCLE_TRANSITIONS.active.archive).toBe("archived");
  });
  test("active -complete→ complete", () => {
    expect(EPIC_LIFECYCLE_TRANSITIONS.active.complete).toBe("complete");
  });
  test("complete -archive→ archived", () => {
    expect(EPIC_LIFECYCLE_TRANSITIONS.complete.archive).toBe("archived");
  });
  test("archived -unarchive→ pending", () => {
    expect(EPIC_LIFECYCLE_TRANSITIONS.archived.unarchive).toBe("pending");
  });
});

// ─── applyEpicTransition — happy paths ───────────────────────────────────────

describe("applyEpicTransition — stage events (update current_stage only)", () => {
  test("pending/spec + epic_spec_approved → pending/plan", () => {
    const next = applyEpicTransition({ status: "pending", current_stage: "spec" }, "epic_spec_approved");
    expect(next).toEqual({ status: "pending", current_stage: "plan" });
  });

  test("active/spec + epic_spec_approved → active/plan", () => {
    const next = applyEpicTransition({ status: "active", current_stage: "spec" }, "epic_spec_approved");
    expect(next).toEqual({ status: "active", current_stage: "plan" });
  });

  test("active/plan + epic_plan_approved → active/build", () => {
    const next = applyEpicTransition({ status: "active", current_stage: "plan" }, "epic_plan_approved");
    expect(next).toEqual({ status: "active", current_stage: "build" });
  });

  test("active/build + epic_build_done → active/assess", () => {
    const next = applyEpicTransition({ status: "active", current_stage: "build" }, "epic_build_done");
    expect(next).toEqual({ status: "active", current_stage: "assess" });
  });

  test("active/assess + epic_assess_done → active/assess (terminal no-op)", () => {
    const next = applyEpicTransition({ status: "active", current_stage: "assess" }, "epic_assess_done");
    expect(next).toEqual({ status: "active", current_stage: "assess" });
  });
});

describe("applyEpicTransition — lifecycle events (update status only)", () => {
  test("pending + start → active/same stage", () => {
    const next = applyEpicTransition({ status: "pending", current_stage: "spec" }, "start");
    expect(next).toEqual({ status: "active", current_stage: "spec" });
  });

  test("pending + archive → archived/same stage", () => {
    const next = applyEpicTransition({ status: "pending", current_stage: "spec" }, "archive");
    expect(next).toEqual({ status: "archived", current_stage: "spec" });
  });

  test("active + archive → archived/same stage", () => {
    const next = applyEpicTransition({ status: "active", current_stage: "build" }, "archive");
    expect(next).toEqual({ status: "archived", current_stage: "build" });
  });

  test("complete + archive → archived/same stage", () => {
    const next = applyEpicTransition({ status: "complete", current_stage: "assess" }, "archive");
    expect(next).toEqual({ status: "archived", current_stage: "assess" });
  });

  test("archived + unarchive → pending/same stage", () => {
    const next = applyEpicTransition({ status: "archived", current_stage: "assess" }, "unarchive");
    expect(next).toEqual({ status: "pending", current_stage: "assess" });
  });

  test("active + complete → complete/same stage", () => {
    const next = applyEpicTransition({ status: "active", current_stage: "assess" }, "complete");
    expect(next).toEqual({ status: "complete", current_stage: "assess" });
  });
});

// ─── applyEpicTransition — InvalidTransitionError ────────────────────────────

describe("applyEpicTransition — InvalidTransitionError on illegal pairs", () => {
  const cases: Array<[EpicState, Parameters<typeof applyEpicTransition>[1]]> = [
    // wrong stage for stage event
    [{ status: "active", current_stage: "plan" }, "epic_spec_approved"],
    [{ status: "active", current_stage: "spec" }, "epic_plan_approved"],
    [{ status: "active", current_stage: "spec" }, "epic_build_done"],
    [{ status: "active", current_stage: "spec" }, "epic_assess_done"],
    // lifecycle events that don't apply from current status
    [{ status: "active", current_stage: "spec" }, "start"],        // active is not pending
    [{ status: "active", current_stage: "spec" }, "unarchive"],    // not archived
    [{ status: "archived", current_stage: "spec" }, "start"],      // archived can't start
    [{ status: "archived", current_stage: "spec" }, "archive"],    // already archived
    [{ status: "archived", current_stage: "spec" }, "complete"],   // archived can't complete
    [{ status: "complete", current_stage: "assess" }, "complete"], // already complete
    [{ status: "complete", current_stage: "assess" }, "unarchive"],// not archived
    [{ status: "pending", current_stage: "spec" }, "complete"],    // pending can't complete directly
    [{ status: "pending", current_stage: "spec" }, "unarchive"],   // not archived
  ];

  for (const [state, event] of cases) {
    test(`(${state.status}/${state.current_stage}) + '${event}' throws InvalidTransitionError`, () => {
      expect(() => applyEpicTransition(state, event)).toThrow(InvalidTransitionError);
    });
  }
});
