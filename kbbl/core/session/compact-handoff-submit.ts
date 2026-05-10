import { SafirHttpError, type SafirClient } from "../safir/client";
import type { SafirQueue } from "../safir/queue";
import { safirCall } from "../safir/safir-call";
import type { SubmitHandoff } from "../safir/types";
import type { HandoffDoc } from "./handoff-doc";

export interface CompactHandoffSubmitDeps {
  safirClient: SafirClient;
  safirQueue: SafirQueue;
}

export async function submitCompactionHandoff(
  deps: CompactHandoffSubmitDeps,
  phaseId: string,
  handoff: HandoffDoc,
): Promise<void> {
  const ctx = { queue: deps.safirQueue };
  const body: SubmitHandoff = {
    raw_markdown: handoff.raw_markdown,
    parsed: {
      goal: handoff.goal,
      active_subgoals: handoff.active_subgoals,
      decisions_made: handoff.decisions_made,
      approaches_rejected: handoff.approaches_rejected,
      files_in_scope: handoff.files_in_scope,
      open_questions: handoff.open_questions,
      next_action: handoff.next_action,
    },
  };
  try {
    await safirCall(
      ctx,
      () => deps.safirClient.submitHandoff(phaseId, body),
      { method: "POST", path: `/phases/${phaseId}/handoff`, body },
    );
  } catch (err) {
    if (
      err instanceof SafirHttpError &&
      err.status >= 400 &&
      err.status < 500
    ) {
      console.error(
        `kbbl: submitHandoff 4xx for phase ${phaseId}: ${err.status} ${err.message}; compaction proceeding without safir handoff record`,
      );
      return;
    }
    throw err;
  }
}
