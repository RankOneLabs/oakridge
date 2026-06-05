import { describe, expect, test } from "bun:test";

import type { CellEvent, CommitSnapshot } from "./types";
import { buildRunTimeline } from "./runTimelineSelectors";

function makeEvent(kind: string, payload: Record<string, unknown> = {}): CellEvent {
  return { ts: "2026-01-01T00:00:00Z", kind, payload };
}

function makeCommit(index: number): CommitSnapshot {
  return { index, filename: `v${String(index).padStart(4, "0")}.md`, content: `content ${index}` };
}

describe("buildRunTimeline", () => {
  describe("multi-round sequence", () => {
    const events: CellEvent[] = [
      makeEvent("incremental_started", { agent_ids: ["a1", "a2"], retry_budget: 3 }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p1", reason: null, new_version: "v0001" }),
      makeEvent("proposal_applied", { agent_id: "a2", proposal_id: "p2", reason: null, new_version: "v0002" }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p3", reason: null, new_version: "v0003" }),
      makeEvent("incremental_terminated", { terminated_by: "budget", commit_counts: { a1: 2, a2: 1 } }),
      makeEvent("convergence_started", { mechanism: "voting", agent_ids: ["a1", "a2"] }),
      makeEvent("round_completed", { round_index: 1, converged: false, n_proposals: 3 }),
      makeEvent("round_completed", { round_index: 2, converged: true, n_proposals: 1 }),
      makeEvent("escalation_triggered", { round_index: 2, n_residual_proposals: 1 }),
      makeEvent("proposal_picked", { agent_id: "a1", proposal_id: "p3", rationale: "best coverage", converged_at_round: 2 }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p3", reason: null, new_version: "v0004" }),
    ];

    const commits: CommitSnapshot[] = [makeCommit(0), makeCommit(1), makeCommit(2)];

    const timeline = buildRunTimeline({ events, commits, metadata: null });

    test("groups incremental_updates from pre-terminate applies", () => {
      expect(timeline.incremental_updates).toHaveLength(3);
    });

    test("pairs incremental updates with commits by apply order", () => {
      expect(timeline.incremental_updates[0].commit?.index).toBe(0);
      expect(timeline.incremental_updates[1].commit?.index).toBe(1);
      expect(timeline.incremental_updates[2].commit?.index).toBe(2);
    });

    test("incremental update applyIndex is 0-based positional", () => {
      expect(timeline.incremental_updates[0].applyIndex).toBe(0);
      expect(timeline.incremental_updates[1].applyIndex).toBe(1);
      expect(timeline.incremental_updates[2].applyIndex).toBe(2);
    });

    test("groups consensus_rounds from round_completed events", () => {
      expect(timeline.consensus_rounds).toHaveLength(2);
    });

    test("maps round_completed fields correctly (1-based round_index)", () => {
      expect(timeline.consensus_rounds[0].roundIndex).toBe(1);
      expect(timeline.consensus_rounds[0].converged).toBe(false);
      expect(timeline.consensus_rounds[0].nProposals).toBe(3);
      expect(timeline.consensus_rounds[1].roundIndex).toBe(2);
      expect(timeline.consensus_rounds[1].converged).toBe(true);
      expect(timeline.consensus_rounds[1].nProposals).toBe(1);
    });

    test("captures escalation event", () => {
      expect(timeline.escalation).not.toBeNull();
      expect(timeline.escalation?.kind).toBe("escalation_triggered");
    });

    test("captures picked_proposal event", () => {
      expect(timeline.picked_proposal).not.toBeNull();
      expect(timeline.picked_proposal?.kind).toBe("proposal_picked");
    });

    test("captures final_apply as the proposal_applied after proposal_picked", () => {
      expect(timeline.final_apply).not.toBeNull();
      expect(timeline.final_apply?.kind).toBe("proposal_applied");
      const payload = timeline.final_apply?.payload as { new_version: string };
      expect(payload.new_version).toBe("v0004");
    });

    test("final_apply is not included in incremental_updates", () => {
      const finalApplyEvent = timeline.final_apply;
      const inIncremental = timeline.incremental_updates.some(
        (u) => u.event === finalApplyEvent,
      );
      expect(inIncremental).toBe(false);
    });
  });

  describe("single_agent sequence (no consensus data)", () => {
    const events: CellEvent[] = [
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p1", reason: null, new_version: "v0001" }),
    ];

    const commits: CommitSnapshot[] = [makeCommit(0)];

    const timeline = buildRunTimeline({ events, commits, metadata: null });

    test("incremental_updates collects applies when no incremental_terminated", () => {
      expect(timeline.incremental_updates).toHaveLength(1);
    });

    test("consensus_rounds is empty", () => {
      expect(timeline.consensus_rounds).toHaveLength(0);
    });

    test("escalation is null", () => {
      expect(timeline.escalation).toBeNull();
    });

    test("picked_proposal is null", () => {
      expect(timeline.picked_proposal).toBeNull();
    });

    test("final_apply is null", () => {
      expect(timeline.final_apply).toBeNull();
    });
  });

  describe("empty event sequence", () => {
    const timeline = buildRunTimeline({ events: [], commits: [], metadata: null });

    test("all sections are empty or null", () => {
      expect(timeline.incremental_updates).toHaveLength(0);
      expect(timeline.consensus_rounds).toHaveLength(0);
      expect(timeline.escalation).toBeNull();
      expect(timeline.picked_proposal).toBeNull();
      expect(timeline.final_apply).toBeNull();
    });
  });

  describe("consensus-only run (no incremental phase, no incremental_terminated)", () => {
    const events: CellEvent[] = [
      makeEvent("convergence_started", { mechanism: "voting", agent_ids: ["a1", "a2"] }),
      makeEvent("round_completed", { round_index: 1, converged: true, n_proposals: 2 }),
      makeEvent("proposal_picked", { agent_id: "a1", proposal_id: "p1", rationale: "best", converged_at_round: 1 }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p1", reason: null, new_version: "v0001" }),
    ];

    const timeline = buildRunTimeline({ events, commits: [], metadata: null });

    test("incremental_updates is empty (no incremental phase)", () => {
      expect(timeline.incremental_updates).toHaveLength(0);
    });

    test("consensus_rounds has one entry", () => {
      expect(timeline.consensus_rounds).toHaveLength(1);
    });

    test("final_apply is captured (post-proposal_picked apply)", () => {
      expect(timeline.final_apply).not.toBeNull();
      expect(timeline.final_apply?.kind).toBe("proposal_applied");
    });

    test("final_apply is not in incremental_updates", () => {
      const inIncremental = timeline.incremental_updates.some(
        (u) => u.event === timeline.final_apply,
      );
      expect(inIncremental).toBe(false);
    });
  });

  describe("commits paired by sorted index", () => {
    const events: CellEvent[] = [
      makeEvent("incremental_started", { agent_ids: ["a1"], retry_budget: 5 }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p1", reason: null, new_version: "v0001" }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p2", reason: null, new_version: "v0002" }),
      makeEvent("incremental_terminated", { terminated_by: "budget", commit_counts: { a1: 2 } }),
    ];

    const commitsOutOfOrder: CommitSnapshot[] = [makeCommit(1), makeCommit(0)];

    const timeline = buildRunTimeline({ events, commits: commitsOutOfOrder, metadata: null });

    test("sorts commits by index before pairing", () => {
      expect(timeline.incremental_updates[0].commit?.index).toBe(0);
      expect(timeline.incremental_updates[1].commit?.index).toBe(1);
    });
  });

  describe("fewer commits than incremental updates", () => {
    const events: CellEvent[] = [
      makeEvent("incremental_started", { agent_ids: ["a1"], retry_budget: 5 }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p1", reason: null, new_version: "v0001" }),
      makeEvent("proposal_applied", { agent_id: "a1", proposal_id: "p2", reason: null, new_version: "v0002" }),
      makeEvent("incremental_terminated", { terminated_by: "budget", commit_counts: { a1: 1 } }),
    ];

    const timeline = buildRunTimeline({ events, commits: [makeCommit(0)], metadata: null });

    test("second update has null commit when no snapshot available", () => {
      expect(timeline.incremental_updates[0].commit?.index).toBe(0);
      expect(timeline.incremental_updates[1].commit).toBeNull();
    });
  });
});
