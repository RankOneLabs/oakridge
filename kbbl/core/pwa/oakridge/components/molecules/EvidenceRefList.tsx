import { Chip } from "../../../components/atoms/Chip";
import type { EvidenceRef } from "../../lib/assessment";

interface Props { refs: readonly EvidenceRef[] }

/** An assessor's cited evidence, one line per reference: its kind, the reference, then any detail. */
export function EvidenceRefList({ refs }: Props) {
  return (
    <ul className="m-0 flex list-none flex-col gap-1 p-0" data-testid="or-evidence-refs">
      {refs.map((ref, index) => (
        <li key={`${index}-${ref.kind}-${ref.ref}`} className="text-sm text-[var(--text-secondary)]" data-testid="or-evidence-ref">
          <Chip tone="muted">{ref.kind}</Chip> <code className="or-code">{ref.ref}</code>
          {ref.detail && <span className="ml-2">{ref.detail}</span>}
        </li>
      ))}
    </ul>
  );
}
