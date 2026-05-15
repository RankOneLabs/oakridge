import { Database } from "bun:sqlite";

/**
 * Kahn's-algorithm cycle detection over cohort_dependencies for a single plan.
 * Returns true if adding edge (from → to) would create a cycle.
 */
export function hasCycleAfterInsert(db: Database, from: string, to: string): boolean {
  const fromRow = db
    .prepare<{ plan_id: string }, [string]>("SELECT plan_id FROM cohorts WHERE id = ?")
    .get(from);
  if (!fromRow) return false;

  const planId = fromRow.plan_id;

  const cohorts = db
    .prepare<{ id: string }, [string]>("SELECT id FROM cohorts WHERE plan_id = ?")
    .all(planId);

  const deps = db
    .prepare<{ from_cohort_id: string; to_cohort_id: string }, [string]>(
      `SELECT cd.from_cohort_id, cd.to_cohort_id
       FROM cohort_dependencies cd
       JOIN cohorts c ON c.id = cd.from_cohort_id
       WHERE c.plan_id = ?`,
    )
    .all(planId);

  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const { id } of cohorts) {
    inDegree.set(id, 0);
    adj.set(id, []);
  }

  for (const { from_cohort_id, to_cohort_id } of [...deps, { from_cohort_id: from, to_cohort_id: to }]) {
    adj.get(from_cohort_id)?.push(to_cohort_id);
    inDegree.set(to_cohort_id, (inDegree.get(to_cohort_id) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [id, deg] of inDegree) {
    if (deg === 0) queue.push(id);
  }

  let processed = 0;
  while (queue.length > 0) {
    const node = queue.shift()!;
    processed++;
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(neighbor) ?? 0) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  return processed < cohorts.length;
}
