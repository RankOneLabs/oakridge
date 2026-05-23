import { describe, expect, test } from "bun:test";

import { parseHandoffMarkdown } from "./handoff-doc";

const ctx = {
  from_session_id: "old-sid",
  produced_at: "2026-05-09T00:00:00.000Z",
};

describe("parseHandoffMarkdown well-formed", () => {
  test("well-formed handoff parses every section", () => {
    const md = `## Goal
Land the runCompact integration.

- finish parser
- wire compactor

## Decisions made
- chose Compactor class: cleaner state than free functions
- one-shot subscriber: avoids leaked promises

## Approaches rejected
- imperative inline parse inside runCompact — duplicates shared logic

## Files & state in scope
- kbbl/core/session/handoff-doc.ts
- kbbl/core/session/compactor.ts

## Open questions
- does PR-3 emit compact_completed?

## Next concrete action
Wire submitCompactionHandoff into runCompact step 7.5.
`;

    const result = parseHandoffMarkdown(md, ctx);

    expect(result.goal).toBe("Land the runCompact integration.");
    expect(result.active_subgoals.length).toBe(2);
    expect(result.active_subgoals).toEqual(["finish parser", "wire compactor"]);

    expect(result.decisions_made.length).toBe(2);
    for (const d of result.decisions_made) {
      expect(d.decision.length).toBeGreaterThan(0);
      expect(d.rationale.length).toBeGreaterThan(0);
    }

    expect(result.approaches_rejected.length).toBe(1);
    expect(result.approaches_rejected[0]!.reason.length).toBeGreaterThan(0);

    expect(result.files_in_scope).toEqual([
      "kbbl/core/session/handoff-doc.ts",
      "kbbl/core/session/compactor.ts",
    ]);

    expect(result.open_questions.length).toBe(1);
    expect(result.next_action).toBe(
      "Wire submitCompactionHandoff into runCompact step 7.5.",
    );

    expect(result.raw_markdown).toBe(md);

    expect(result.from_session_id).toBe("old-sid");
  });

  test("missing section leaves field at default", () => {
    const md = `## Goal
Carry forward.

## Next concrete action
Resume work on step 5.
`;

    const result = parseHandoffMarkdown(md, ctx);

    expect(result.decisions_made).toEqual([]);
    expect(result.approaches_rejected).toEqual([]);
    expect(result.files_in_scope).toEqual([]);
    expect(result.open_questions).toEqual([]);
    expect(result.goal).toBe("Carry forward.");
    expect(result.next_action).toBe("Resume work on step 5.");
  });
});

describe("parseHandoffMarkdown malformed", () => {
  test("garbage input produces a HandoffDoc with raw_markdown set", () => {
    const md = "this is not handoff doc structure, just prose";
    const result = parseHandoffMarkdown(md, ctx);

    expect(result.goal).toBe("");
    expect(result.active_subgoals).toEqual([]);
    expect(result.raw_markdown).toBe(md);
  });

  test("empty string input produces all defaults", () => {
    const result = parseHandoffMarkdown("", ctx);
    expect(result.raw_markdown).toBe("");
    expect(result.goal).toBe("");
    expect(result.active_subgoals).toEqual([]);
    expect(result.decisions_made).toEqual([]);
    expect(result.approaches_rejected).toEqual([]);
    expect(result.files_in_scope).toEqual([]);
    expect(result.open_questions).toEqual([]);
    expect(result.next_action).toBe("");
  });

  test("header paraphrasing tolerated via slug match", () => {
    const md = `## Files and state in scope
- a.ts
- b.ts
`;
    const result = parseHandoffMarkdown(md, ctx);
    expect(result.files_in_scope).toEqual(["a.ts", "b.ts"]);
  });
});

describe("parseHandoffMarkdown bullet-shape variants", () => {
  test("decision bullet without separator becomes decision-only", () => {
    const md = `## Decisions made
- chose X without explanation
`;
    const result = parseHandoffMarkdown(md, ctx);
    expect(result.decisions_made).toEqual([
      { decision: "chose X without explanation", rationale: "" },
    ]);
  });

  test("numbered lists work", () => {
    const md = `## Files & state in scope
1. file-a.ts
2. file-b.ts
`;
    const result = parseHandoffMarkdown(md, ctx);
    expect(result.files_in_scope).toEqual(["file-a.ts", "file-b.ts"]);
  });

  test("multi-line bullet (continuation indent) is concatenated", () => {
    const md = `## Open questions
- this question
  has a continuation
- a second question
`;
    const result = parseHandoffMarkdown(md, ctx);
    expect(result.open_questions).toEqual([
      "this question has a continuation",
      "a second question",
    ]);
  });

  test("multi-line bullet (unindented continuation) is concatenated", () => {
    const md = `## Open questions
- this question
has an unindented wrap
- a second question
`;
    const result = parseHandoffMarkdown(md, ctx);
    expect(result.open_questions).toEqual([
      "this question has an unindented wrap",
      "a second question",
    ]);
  });
});
