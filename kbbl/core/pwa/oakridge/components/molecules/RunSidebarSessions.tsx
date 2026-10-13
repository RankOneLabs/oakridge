import type { RunAttempt } from "../../lib/run-sessions";
import { StatusBadge } from "../atoms/StatusBadge";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly attempts: readonly RunAttempt[]; readonly onOpen: (unitId: string) => void }
export function RunSidebarSessions({ attempts, onOpen }: Props) {
  return <section data-testid="or-sidebar-sessions"><h3>Attempts</h3>
    {attempts.length === 0 && <p>No attempts yet.</p>}
    <ul>{attempts.map(({ unit_id, attempt }) => <li key={attempt.id} className="flex items-center gap-2">
      <Button variant="secondary" onClick={() => onOpen(unit_id)}>{attempt.worker} #{attempt.number}</Button>
      <StatusBadge status={attempt.status} />
    </li>)}</ul>
  </section>;
}
