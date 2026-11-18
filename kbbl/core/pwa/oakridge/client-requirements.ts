import { readRunTasks, type RunTasksRequest } from "./client-grading";
import type { ObservationPaged } from "./grading-contracts/grading/composite";
import type { ObservationCompositeRead } from "./grading-contracts/grading/item-reads";
/** Exhaust the read before joining; a missing grade must not mean an unread page. */
export async function readRunRequirementComposites({ run_id, nested }: Pick<RunTasksRequest, "run_id" | "nested">): Promise<ObservationPaged<ObservationCompositeRead>> {
  const items: ObservationCompositeRead[] = [];
  let offset = 0;
  while (true) {
    const page = await readRunTasks({ run_id, nested, page: { limit: 200, offset } });
    items.push(...page.items);
    offset += page.items.length;
    if (offset >= page.total) return { items, total: items.length, limit: Math.max(items.length, 1), offset: 0 };
    if (!page.items.length) throw new Error("Requirement grading read did not advance; results are incomplete.");
  }
}
