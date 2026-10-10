import type { RunExecution } from "../../lib/run-sessions";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly executions: readonly RunExecution[]; readonly onOpen: (scopeId: string) => void }
export function RunSidebarSessions({ executions, onOpen }: Props) {
  return <section data-testid="or-sidebar-sessions"><h3>Executions</h3>
    {executions.length === 0 && <p>No executions yet.</p>}
    <ul>{executions.map(({ scope_id, execution }) => <li key={execution.id} className="flex items-center gap-2">
      <Button variant="secondary" onClick={() => onOpen(scope_id)}>{execution.worker_key} #{execution.generation}</Button>
      <StatusBadge status={execution.status} />
    </li>)}</ul>
  </section>;
}
