import type { OperatorDefinitionSummary } from "../../operator-contracts";
import { Button } from "../../../components/atoms/Button";

interface Props { readonly definitions: readonly OperatorDefinitionSummary[]; readonly onSelect: (id: string) => void;
  readonly onClone: (id: string) => void; readonly onArchive: (id: string) => void; readonly isArchived: boolean }
export function WorkflowDefList({ definitions, onSelect, onClone, onArchive, isArchived }: Props) {
  return <ul data-testid="or-def-list">{definitions.map((definition) => <li key={definition.bundle_id} className="flex items-center gap-3 py-2">
    <Button variant="secondary" onClick={() => onSelect(definition.bundle_id)}>{definition.source.key} v{definition.source.version}</Button>
    <code>{definition.digest}</code>
    <Button variant="secondary" onClick={() => onClone(definition.bundle_id)}>Clone</Button>
    <Button variant="secondary" onClick={() => onArchive(definition.bundle_id)}>{isArchived ? "Unarchive" : "Archive"}</Button>
  </li>)}</ul>;
}
