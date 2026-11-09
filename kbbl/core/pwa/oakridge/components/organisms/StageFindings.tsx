import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import type { ObservationPageRequest } from "../../grading-contracts/grading/composite";
import type { ObservationItemAddress } from "../../grading-contracts/grading/item-reads";
import { useRunFindings } from "../../hooks/useRunFindings";
import { selectItemText, stageLabel, taskLinkLabel } from "../../lib/grading";
import { GradeItemButton } from "../molecules/GradeItemButton";
import { ListPager } from "../molecules/ListPager";

const FIRST: ObservationPageRequest = { limit: 50, offset: 0 };

interface Props {
  runId: string;
  stage: string;
  onOpenItem: (selection: ObservationItemAddress) => void;
  onOpenTask?: (task_id: string) => void;
  /** Older revisions stay inspectable, on request. */
  canShowOlder?: boolean;
}

/** Every finding of one stage, linked or not. It shows no answer, so it reads the same hidden or revealed. */
export function StageFindings({ runId, stage, onOpenItem, onOpenTask, canShowOlder = true }: Props) {
  const [page, setPage] = useState(FIRST);
  const [links, setLinks] = useState(FIRST);
  const [isOlderShown, setIsOlderShown] = useState(false);
  const query = useRunFindings(runId, { stage, is_current_only: !isOlderShown, page, links });
  return (
    <section className="flex flex-col gap-2" data-testid="or-stage-findings" data-stage={stage}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{stageLabel(stage)} findings{query.data ? ` (${query.data.total})` : ""}</h4>
        {canShowOlder && <Button variant="secondary" size="xsmall" className="text-xs!" aria-pressed={isOlderShown} onClick={() => { setIsOlderShown(!isOlderShown); setPage(FIRST); }}>
          {isOlderShown ? "Latest revisions only" : "Include older revisions"}
        </Button>}
      </div>
      {query.isError && <FeedbackMessage tone="muted" testId="or-stage-findings-unavailable">Findings are unavailable: {query.error instanceof Error ? query.error.message : "observation did not answer"}</FeedbackMessage>}
      {query.data?.total === 0 && <p className="m-0 text-sm text-[var(--text-muted)]">None published yet.</p>}
      <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
        {query.data?.items.map((row) => (
          <li key={row.item.occurrence_id} className="flex flex-col gap-1 py-2" data-testid="or-stage-finding" data-item-path={row.item.item_path} data-revision={row.item.source_revision_id}>
            <div className="flex items-start gap-2">
              <p className="m-0 min-w-0 flex-1 text-sm text-[var(--text-secondary)]">{selectItemText(row.item.selected_value)}</p>
              <GradeItemButton selection={{ source_revision_id: row.item.source_revision_id, item_path: row.item.item_path }} onOpenItem={onOpenItem} />
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-[var(--text-muted)]">
              <code className="or-code">{row.item.source_revision_id} {row.item.item_path}</code>
              {!row.item.is_current && <Chip tone="muted">Older revision</Chip>}
              {row.links.total === 0 && <Chip tone="muted" testId="or-finding-unlinked">Unlinked</Chip>}
              {row.links.items.map((link) => onOpenTask
                ? <Button key={link.relation_id} variant="secondary" size="xsmall" className="text-xs!" onClick={() => onOpenTask(link.producer_local_id)} data-testid="or-finding-task-link" data-link-state={link.state}>{taskLinkLabel(link)}</Button>
                : <Chip key={link.relation_id} tone={link.state === "resolved" ? "neutral" : "warning"}>{taskLinkLabel(link)}</Chip>)}
              {query.data && <ListPager name="links" page={row.links} onWindow={setLinks} />}
            </div>
          </li>
        ))}
      </ul>
      {query.data && <ListPager name={`${stage}-findings`} page={query.data} onWindow={setPage} />}
    </section>
  );
}
