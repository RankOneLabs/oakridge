import type { OperatorRunView } from "../../operator-contracts";
import { selectRunProgress } from "../../lib/run-overview";
import { selectRunAccentClass } from "../../lib/run-accent";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";

interface Props { readonly run: OperatorRunView; readonly onBack: () => void }
export function RunIdentityHeader({ run, onBack }: Props) {
  const progress = selectRunProgress(run);
  return <header className={`or-page-header ${selectRunAccentClass(run.run_id)}`} data-testid="or-run-identity">
    <span className="or-run-identity__accent" aria-hidden="true" />
    <Button variant="secondary" onClick={onBack}>← Runs</Button>
    <div><h1 className="or-page-title">{run.run_id}</h1><small>{run.definition_digest}</small></div>
    <Chip tone="info">{progress.complete}/{progress.total} scopes complete</Chip>
    {progress.needs_attention > 0 && <Chip tone="warning">{progress.needs_attention} need attention</Chip>}
  </header>;
}
