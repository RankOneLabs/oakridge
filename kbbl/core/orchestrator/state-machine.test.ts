import { describe, expect, test } from "bun:test";
import {
  COHORT_TRANSITIONS,
  PLAN_TRANSITIONS,
  BRIEF_TRANSITIONS,
  applyCohortTransition,
  type CohortStatus,
} from "./state-machine";

describe("COHORT_TRANSITIONS table", () => {
  test("waiting -dependencies_met→ planned", () => {
    expect(COHORT_TRANSITIONS.waiting.dependencies_met).toBe("planned");
  });

  test("planned -briefing_started→ briefing", () => {
    expect(COHORT_TRANSITIONS.planned.briefing_started).toBe("briefing");
  });

  test("briefing -brief_submitted→ brief_review", () => {
    expect(COHORT_TRANSITIONS.briefing.brief_submitted).toBe("brief_review");
  });

  test("brief_review -brief_approved→ building", () => {
    expect(COHORT_TRANSITIONS.brief_review.brief_approved).toBe("building");
  });

  test("brief_review -brief_rejected→ briefing", () => {
    expect(COHORT_TRANSITIONS.brief_review.brief_rejected).toBe("briefing");
  });

  test("building -pr_merged→ done", () => {
    expect(COHORT_TRANSITIONS.building.pr_merged).toBe("done");
  });

  test("every non-blocked status has block→ blocked", () => {
    const statuses: CohortStatus[] = ["waiting", "planned", "briefing", "brief_review", "building", "done"];
    for (const s of statuses) {
      expect(COHORT_TRANSITIONS[s].block).toBe("blocked");
    }
  });

  test("blocked has no block transition (already blocked)", () => {
    expect(COHORT_TRANSITIONS.blocked.block).toBeUndefined();
  });
});

describe("PLAN_TRANSITIONS table", () => {
  test("pending_approval -approve→ approved", () => {
    expect(PLAN_TRANSITIONS.pending_approval.approve).toBe("approved");
  });

  test("pending_approval -reject→ rejected", () => {
    expect(PLAN_TRANSITIONS.pending_approval.reject).toBe("rejected");
  });

  test("approved -supersede→ superseded", () => {
    expect(PLAN_TRANSITIONS.approved.supersede).toBe("superseded");
  });

  test("rejected -supersede→ superseded", () => {
    expect(PLAN_TRANSITIONS.rejected.supersede).toBe("superseded");
  });

  test("superseded has no outbound transitions", () => {
    expect(Object.keys(PLAN_TRANSITIONS.superseded)).toHaveLength(0);
  });
});

describe("BRIEF_TRANSITIONS table", () => {
  test("pending_approval -approve→ approved", () => {
    expect(BRIEF_TRANSITIONS.pending_approval.approve).toBe("approved");
  });

  test("pending_approval -reject→ rejected", () => {
    expect(BRIEF_TRANSITIONS.pending_approval.reject).toBe("rejected");
  });

  test("approved -supersede→ superseded", () => {
    expect(BRIEF_TRANSITIONS.approved.supersede).toBe("superseded");
  });

  test("superseded has no outbound transitions", () => {
    expect(Object.keys(BRIEF_TRANSITIONS.superseded)).toHaveLength(0);
  });
});

describe("applyCohortTransition", () => {
  test("valid forward transitions return next status", () => {
    expect(applyCohortTransition("waiting", "dependencies_met")).toBe("planned");
    expect(applyCohortTransition("planned", "briefing_started")).toBe("briefing");
    expect(applyCohortTransition("briefing", "brief_submitted")).toBe("brief_review");
    expect(applyCohortTransition("brief_review", "brief_approved")).toBe("building");
    expect(applyCohortTransition("brief_review", "brief_rejected")).toBe("briefing");
    expect(applyCohortTransition("building", "pr_merged")).toBe("done");
  });

  test("block from any non-blocked state returns blocked", () => {
    const statuses: CohortStatus[] = ["waiting", "planned", "briefing", "brief_review", "building", "done"];
    for (const s of statuses) {
      expect(applyCohortTransition(s, "block")).toBe("blocked");
    }
  });

  test("unblock from blocked restores preBlockStatus", () => {
    expect(applyCohortTransition("blocked", "unblock", "briefing")).toBe("briefing");
    expect(applyCohortTransition("blocked", "unblock", "building")).toBe("building");
    expect(applyCohortTransition("blocked", "unblock", "planned")).toBe("planned");
  });

  test("unblock from non-blocked returns error", () => {
    const result = applyCohortTransition("planned", "unblock");
    expect(result).toMatchObject({ error: expect.stringContaining("cannot unblock") });
  });

  test("unblock without preBlockStatus returns error", () => {
    const result = applyCohortTransition("blocked", "unblock", null);
    expect(result).toMatchObject({ error: expect.stringContaining("pre_block_status") });
  });

  test("undefined transition returns error", () => {
    const result = applyCohortTransition("done", "dependencies_met");
    expect(result).toMatchObject({ error: expect.stringContaining("no transition") });
  });

  test("block from blocked returns error (no transition defined)", () => {
    const result = applyCohortTransition("blocked", "block");
    expect(result).toMatchObject({ error: expect.stringContaining("no transition") });
  });
});
