import { useQuery } from "@tanstack/react-query";
import { readItemAt, readItemStatus } from "../client-grading";
import type { ObservationPageRequest } from "../grading-contracts/grading/composite";
import type { ObservationItemAddress } from "../grading-contracts/grading/item-reads";

const QUESTIONS: ObservationPageRequest = { limit: 200, offset: 0 };
const ONE: ObservationPageRequest = { limit: 1, offset: 0 };
/** Enough of each question for a glance: every automatic evaluator and every current answer, and one of everything else. */
const GLANCE_WINDOWS = { machine: QUESTIONS, answers: QUESTIONS, attempts: ONE, superseded_answers: ONE, references: ONE, pinned_evaluators: ONE, links: ONE };

/**
 * One finding row's grading summary on an artifact: its exact revision and path resolved to the
 * captured item, then that item's status. Polls alongside the item panel so a provider answer
 * arriving after the artifact opened replaces its pending badge without a browser refresh.
 */
export function useItemGlance(run_id: string, selection: ObservationItemAddress) {
  return useQuery({ queryKey: ["oakridge", "grading", "item-glance", run_id, selection.source_revision_id, selection.item_path, selection.task_id], retry: false, refetchInterval: 10_000,
    queryFn: async () => {
      const item = await readItemAt(run_id, selection);
      return readItemStatus({ occurrence_id: item.occurrence_id, task_id: selection.task_id, top: QUESTIONS, nested: GLANCE_WINDOWS });
    } });
}
