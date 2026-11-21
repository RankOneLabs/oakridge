import { Chip } from "../../../components/atoms/Chip";
import type { OperatorActionRow } from "../../lib/operator-actions";

interface OperatorActionsListProps {
  readonly rows: readonly OperatorActionRow[];
}

export function OperatorActionsList({ rows }: OperatorActionsListProps) {
  return (
    <section data-testid="or-operator-actions" className="space-y-2 p-2">
      <h2 className="text-sm font-semibold">Operator actions</h2>
      <ul className="space-y-2">
        {rows.map(row => (
          <li key={row.key} data-testid="or-operator-action" className="space-y-1 rounded border p-2 text-sm wrap-anywhere">
            <Chip tone="neutral">{row.disposition_label}</Chip>
            {row.original_text !== null && <p className="whitespace-pre-wrap"><strong>Original</strong> {row.original_text}</p>}
            {row.final_text !== null && <p className="whitespace-pre-wrap"><strong>Final</strong> {row.final_text}</p>}
            <p className="text-xs">{row.source_label} · Assessment {row.assessment_revision_id}</p>
            <p className="text-xs">
              {row.review} / {row.decision} · {row.actor_label} ·{" "}
              <time dateTime={row.created_at}>{row.created_at}</time>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
