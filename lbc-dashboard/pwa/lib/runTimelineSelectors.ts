import type { CellEvent, CellRunMetadata, CommitSnapshot } from "./types";

export interface RunTimelineInput {
  events: CellEvent[];
  commits: CommitSnapshot[];
  metadata: CellRunMetadata | null;
}

export interface IncrementalUpdate {
  event: CellEvent;
  applyIndex: number;
  commit: CommitSnapshot | null;
}

export interface ConsensusRound {
  event: CellEvent;
  roundIndex: number;
  converged: boolean;
  nProposals: number;
}

export interface RunTimeline {
  incremental_updates: IncrementalUpdate[];
  consensus_rounds: ConsensusRound[];
  escalation: CellEvent | null;
  picked_proposal: CellEvent | null;
  final_apply: CellEvent | null;
}

export function buildRunTimeline(input: RunTimelineInput): RunTimeline {
  const { events, commits } = input;

  const terminateIdx = events.findIndex((e) => e.kind === "incremental_terminated");

  const pickedIdx = events.findIndex((e) => e.kind === "proposal_picked");

  const incrementalApplies: CellEvent[] = [];
  for (let i = 0; i < events.length; i++) {
    if (terminateIdx !== -1 && i >= terminateIdx) break;
    if (events[i].kind === "proposal_applied") {
      incrementalApplies.push(events[i]);
    }
  }

  const sortedCommits = [...commits].sort((a, b) => a.index - b.index);

  const incremental_updates: IncrementalUpdate[] = incrementalApplies.map(
    (event, n) => ({
      event,
      applyIndex: n,
      commit: sortedCommits[n] ?? null,
    }),
  );

  const consensus_rounds: ConsensusRound[] = events
    .filter((e) => e.kind === "round_completed")
    .map((e) => {
      const p = e.payload as { round_index: number; converged: boolean; n_proposals: number };
      return {
        event: e,
        roundIndex: p.round_index,
        converged: p.converged,
        nProposals: p.n_proposals,
      };
    });

  const escalation = events.find((e) => e.kind === "escalation_triggered") ?? null;

  const picked_proposal = pickedIdx !== -1 ? events[pickedIdx] : null;

  let final_apply: CellEvent | null = null;
  if (pickedIdx !== -1) {
    for (let i = pickedIdx + 1; i < events.length; i++) {
      if (events[i].kind === "proposal_applied") {
        final_apply = events[i];
        break;
      }
    }
  }

  return { incremental_updates, consensus_rounds, escalation, picked_proposal, final_apply };
}
