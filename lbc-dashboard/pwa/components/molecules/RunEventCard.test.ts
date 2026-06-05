import { describe, expect, test } from "bun:test";

import {
  classifyProposalApplied,
  idSuffix,
  resolveModel,
} from "./RunEventCard";
import type { CellEvent, CellRunMetadata } from "../../lib/types";

const METADATA: CellRunMetadata = {
  model_pool: ["claude-sonnet-4-6", "gpt-5-mini"],
  agents: [
    {
      agent_id: "aabbccdd11223344",
      model_id: "claude-sonnet-4-6",
      label: "agent-0",
    },
    {
      agent_id: "11223344aabbccdd",
      model_id: "gpt-5-mini",
      label: "agent-1",
    },
  ],
  attribution_source: "run_spec_derived",
};

function makeEvent(kind: string): CellEvent {
  return { ts: "2026-01-01T00:00:00Z", kind, payload: {} };
}

describe("idSuffix", () => {
  test("returns last 8 characters of a long id", () => {
    expect(idSuffix("aabbccdd11223344")).toBe("11223344");
  });

  test("returns the full string when shorter than 8 chars", () => {
    expect(idSuffix("abcd")).toBe("abcd");
  });

  test("returns exactly 8 chars for a 16-char hex id", () => {
    expect(idSuffix("0000000012345678")).toBe("12345678");
  });
});

describe("resolveModel", () => {
  test("returns suffix only when runMetadata is null", () => {
    expect(resolveModel("aabbccdd11223344", null)).toBe("11223344");
  });

  test("returns ReadableName · suffix when agent found with model_id", () => {
    expect(resolveModel("aabbccdd11223344", METADATA)).toBe(
      "Claude Sonnet 4.6 · 11223344",
    );
  });

  test("returns second model name + suffix correctly", () => {
    expect(resolveModel("11223344aabbccdd", METADATA)).toBe(
      "GPT-5 mini · aabbccdd",
    );
  });

  test("returns suffix alone when agent_id not in metadata", () => {
    expect(resolveModel("ffffffffffffffff", METADATA)).toBe("ffffffff");
  });

  test("returns suffix alone when model_id is null", () => {
    const meta: CellRunMetadata = {
      ...METADATA,
      agents: [
        { agent_id: "aabbccdd11223344", model_id: null, label: "agent-0" },
      ],
    };
    expect(resolveModel("aabbccdd11223344", meta)).toBe("11223344");
  });
});

describe("classifyProposalApplied", () => {
  test("incremental_commit: no prior proposal_picked", () => {
    const events: CellEvent[] = [
      makeEvent("incremental_started"),
      makeEvent("proposal_applied"),
    ];
    expect(classifyProposalApplied(1, events)).toBe("incremental_commit");
  });

  test("terminal_apply: proposal_picked precedes this event", () => {
    const events: CellEvent[] = [
      makeEvent("incremental_started"),
      makeEvent("proposal_picked"),
      makeEvent("proposal_applied"),
    ];
    expect(classifyProposalApplied(2, events)).toBe("terminal_apply");
  });

  test("incremental_commit: proposal_picked comes after this event", () => {
    const events: CellEvent[] = [
      makeEvent("proposal_applied"),
      makeEvent("proposal_picked"),
    ];
    expect(classifyProposalApplied(0, events)).toBe("incremental_commit");
  });

  test("incremental_commit: multiple prior applies, no pick yet", () => {
    const events: CellEvent[] = [
      makeEvent("incremental_started"),
      makeEvent("proposal_applied"),
      makeEvent("round_completed"),
      makeEvent("proposal_applied"),
    ];
    expect(classifyProposalApplied(3, events)).toBe("incremental_commit");
  });

  test("incremental_commit: single event with no prior events", () => {
    const events: CellEvent[] = [makeEvent("proposal_applied")];
    expect(classifyProposalApplied(0, events)).toBe("incremental_commit");
  });
});

describe("RunEventCard kind coverage", () => {
  // These tests verify the pure classification/resolution logic used by each
  // card renderer, organized by event kind, so the test suite documents all
  // known kinds.

  test("incremental_started: resolves model chips from run_metadata", () => {
    const chip = resolveModel("aabbccdd11223344", METADATA);
    expect(chip).toContain("Claude Sonnet 4.6");
    expect(chip).toContain("11223344");
  });

  test("proposal_applied incremental: classifies without prior pick", () => {
    const events: CellEvent[] = [
      makeEvent("incremental_started"),
      makeEvent("proposal_applied"),
    ];
    expect(classifyProposalApplied(1, events)).toBe("incremental_commit");
  });

  test("proposal_applied terminal: classifies with prior pick", () => {
    const events: CellEvent[] = [
      makeEvent("proposal_picked"),
      makeEvent("proposal_applied"),
    ];
    expect(classifyProposalApplied(1, events)).toBe("terminal_apply");
  });

  test("round_completed: no model resolution needed (pure payload read)", () => {
    // round_completed card reads round_index/converged/n_proposals defensively;
    // none of those require run_metadata, so resolveModel is not called.
    expect(idSuffix("round-id-placeholder")).toBe("ceholder");
  });

  test("proposal_picked: resolves picked agent model", () => {
    expect(resolveModel("11223344aabbccdd", METADATA)).toBe(
      "GPT-5 mini · aabbccdd",
    );
  });

  test("cell_failed: fallback suffix when no run_metadata", () => {
    expect(resolveModel("deadbeef12345678", null)).toBe("12345678");
  });

  test("unknown kind: idSuffix still works for any id in fallback", () => {
    expect(idSuffix("some-completely-unknown-event-id")).toBe("event-id");
  });
});
