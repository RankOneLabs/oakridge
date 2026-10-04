import { AdapterRegistry } from "../runtime/executor-registry";
import type { CohortDetailContributor } from "../domain/operator-projections";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";
import { PostgresDevFlowCohortDetailContributor } from "../storage/postgres-dev-flow";

export const registerDevFlowAdapter = (registry: AdapterRegistry): void => {
  for (const role of ["spec", "plan", "brief", "build", "assessment", "final_integration", "provision"]) registry.register_role(role);
};

export const createDevFlowAdapterRegistry = (): AdapterRegistry => {
  const registry = new AdapterRegistry();
  registerDevFlowAdapter(registry);
  return registry;
};

export const registerDevFlowCohortDetails = (
  projections: { register_cohort_detail_contributor(contributor: CohortDetailContributor): void },
  sql: TransactionalSqlExecutor,
): void => projections.register_cohort_detail_contributor(new PostgresDevFlowCohortDetailContributor(sql));
