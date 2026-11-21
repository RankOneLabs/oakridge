import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { TextArea } from "../../../components/atoms/TextArea";
import { DISPOSITION_CONTROL_LABEL, DISPOSITION_RECORDED_LABEL, selectActionSourceLabel, selectDispositionChoice, type ActionDraft, type DispositionChoice, type PendingDisposition } from "../../lib/assessment-adjudication";
import type { OperatorProposedActionEntry } from "../../operator-contracts/domain/adjudication";
import type { OperatorAssessmentAction } from "../../operator-contracts/domain/assessment";

interface Props {
  action: OperatorAssessmentAction;
  pending: PendingDisposition | null;
  /** What was typed for Edit and Drop, so switching back restores it. */
  draft: ActionDraft;
  /** The disposition recorded on this revision; once present the action is read-only. */
  recorded: OperatorProposedActionEntry | null;
  disabled: boolean;
  onChange: (choice: DispositionChoice) => void;
}

const CHOICES = ["accepted", "modified", "rejected"] as const;

/** One assessor action: its words, where it comes from, and Keep / Edit / Drop. */
export function AdjudicationAction({ action, pending, draft, recorded, disabled, onChange }: Props) {
  return <li className="flex flex-col gap-2 rounded-md border border-[var(--border-decorative)] p-3" data-testid="or-adjudication-action">
    {recorded?.disposition === "modified" && recorded.final_text != null
      ? <><p>{recorded.final_text}</p><p className="text-xs text-[var(--text-muted)]">Assessor wrote: {action.text}</p></>
      : <p className={recorded?.disposition === "rejected" ? "line-through text-[var(--text-muted)]" : undefined}>{action.text}</p>}
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-[var(--text-muted)]">{selectActionSourceLabel(action.source)}</span>
      {recorded && <Chip tone={recorded.disposition === "rejected" ? "muted" : "success"}>{DISPOSITION_RECORDED_LABEL[recorded.disposition]}</Chip>}
      {!recorded && <div role="group" aria-label="Disposition" className="ml-auto flex gap-1">{CHOICES.map(disposition =>
        <Button key={disposition} size="xsmall" variant={pending?.disposition === disposition ? "primary" : "secondary"} aria-pressed={pending?.disposition === disposition}
          disabled={disabled} onClick={() => onChange(selectDispositionChoice(draft, disposition))}>{DISPOSITION_CONTROL_LABEL[disposition]}</Button>)}</div>}
    </div>
    {recorded?.reason && <p className="text-xs">Why dropped: {recorded.reason}</p>}
    {!recorded && pending?.disposition === "modified" && <label className="flex flex-col gap-1 text-xs">Replacement text
      <TextArea value={pending.final_text} disabled={disabled} onChange={event => onChange({ kind: "edit", final_text: event.target.value })} /></label>}
    {!recorded && pending?.disposition === "rejected" && <label className="flex flex-col gap-1 text-xs">Why drop it? (optional)
      <TextArea value={pending.reason} disabled={disabled} onChange={event => onChange({ kind: "reject", reason: event.target.value })} /></label>}
  </li>;
}
