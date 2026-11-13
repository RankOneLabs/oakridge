import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { ObservationAddressedItem, ObservationLogicalLinkRead } from "../../grading-contracts/grading/item-reads";
import type { ObservationPaged, ObservationPageRequest } from "../../grading-contracts/grading/composite";
import { useRunUnresolvedReferences } from "../../hooks/useRunUnresolvedReferences";
import { selectSpecTaskId, taskLinkLabel } from "../../lib/grading";
import { selectUnresolvedTaskAssociations } from "../../lib/grading-detail";
import { ListPager } from "../molecules/ListPager";

interface Props {
  readonly runId: string;
  readonly item: ObservationAddressedItem;
  readonly links: ObservationPaged<ObservationLogicalLinkRead>;
  readonly onOpenTask: (task_id: string) => void;
  readonly onWindow: (window: ObservationPageRequest) => void;
}
/** Only resolved recorded ids navigate. Unresolved references remain literal, even if names match. */
export function ItemTaskAssociations({ runId, item, links, onOpenTask, onWindow }: Props) {
  const [page, setPage] = useState<ObservationPageRequest>({ limit: 50, offset: 0 });
  const read = useRunUnresolvedReferences(runId, page);
  const unresolved = selectUnresolvedTaskAssociations({ occurrence_id: item.occurrence_id, links: links.items, unresolved: read.data?.items ?? [] });
  const specTaskId = selectSpecTaskId(item);
  return <section className="flex flex-col gap-2 text-xs text-[var(--text-muted)]" data-testid="or-item-task-links" aria-label="Task associations">
    <div className="flex flex-wrap items-center gap-1.5"><span>{specTaskId === null ? "Linked spec tasks" : "Spec task"}</span>
      {specTaskId !== null && <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => onOpenTask(specTaskId)} data-testid="or-item-spec-task">{specTaskId}</Button>}
      {specTaskId === null && links.total === 0 && <Chip tone="muted">None linked</Chip>}
      {links.items.map((link) => link.state === "resolved"
        ? <Button key={link.relation_id} variant="secondary" size="xsmall" className="text-xs!" onClick={() => onOpenTask(link.producer_local_id)} data-testid="or-item-task-link" data-link-state={link.state}>{taskLinkLabel(link)}</Button>
        : <span key={link.relation_id} data-testid="or-item-task-link" data-link-state={link.state}>{taskLinkLabel(link)}</span>)}
      <ListPager name="links" page={links} onWindow={onWindow} />
    </div>
    <h4 className="m-0 text-xs font-medium">Unresolved task references</h4>
    {read.isError && <p className="m-0">Unresolved task references unavailable.</p>}
    {!read.data && !read.isError && <p className="m-0">Loading unresolved task references…</p>}
    {read.data && unresolved.length === 0 && <p className="m-0">None for this item in this run page.</p>}
    <ul className="m-0 list-none p-0">{unresolved.map((entry) => <li key={entry.relation_id} data-testid="or-item-unresolved-task">Unresolved: <code>{entry.reference}</code> · {entry.evidence_ref}</li>)}</ul>
    {read.data && <ListPager name="run unresolved task references" page={read.data} onWindow={setPage} />}
  </section>;
}
