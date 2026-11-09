import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { DrilldownKey, PageWindow, StageComposite } from "../../grading-types";
import { answerKeyLabel, answerTone, graderLabel, questionLabel, selectStageView, stageLabel, statusKeyLabel } from "../../lib/grading";
import { artifactLabelClass } from "./ArtifactSection";
import { ListPager } from "./ListPager";

interface Props {
  stage: StageComposite;
  isRevealed: boolean;
  onDrill: (key: DrilldownKey, label: string) => void;
  onWindow: (name: "questions" | "answers" | "statuses" | "disagreements", window: PageWindow) => void;
}

function CountButton({ label, count, drill, testId }: { label: string; count: number; drill: () => void; testId: string }) {
  return (
    <Button variant="secondary" size="xsmall" className="text-xs!" onClick={drill} data-testid={testId}>{label}: {count}</Button>
  );
}

/** One stage of one task, kept apart from the others. There is no figure across stages. */
export function StageCompositeColumn({ stage, isRevealed, onDrill, onWindow }: Props) {
  const view = selectStageView(stage, isRevealed);
  return (
    <section className="flex min-w-0 flex-col gap-2 rounded-md border border-[var(--border-subtle)] p-2" data-testid="or-task-stage" data-stage={view.stage}>
      <div className="flex flex-wrap items-center gap-2">
        <h4 className="m-0 text-sm font-semibold text-[var(--text-primary)]">{stageLabel(view.stage)}</h4>
        <Chip tone={view.publication === "Final results" ? "accent" : "muted"}>{view.publication}</Chip>
        {view.coverage === "gap" && <Chip tone="warning" testId="or-task-coverage-gap">No linked items</Chip>}
      </div>
      {view.coverage === "linked" && <p className="m-0 text-xs text-[var(--text-muted)]">{view.contributing_items} linked {view.contributing_items === 1 ? "item" : "items"}</p>}
      {view.kind === "revealed" && (
        <div className="flex flex-col gap-2" data-testid="or-task-stage-counts">
          {view.answers.length > 0 && <div className="flex flex-col gap-1">
            <div className={artifactLabelClass}>Answers</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {view.answers.map((count) => (
                <li key={JSON.stringify(count.drilldown.selector)} className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <span>{questionLabel(count.question)} · {graderLabel(count.grader)}</span>
                  <Chip tone={count.answer.state === "answered" ? answerTone(count.answer.value) : "neutral"}>{answerKeyLabel(count.answer)}</Chip>
                  <CountButton label="items" count={count.count} testId="or-task-answer-count"
                    drill={() => onDrill(count.drilldown, `${questionLabel(count.question)}: ${answerKeyLabel(count.answer)} from ${graderLabel(count.grader)}`)} />
                </li>
              ))}
            </ul>
            <ListPager name="answers" page={stage.answers} onWindow={(window) => onWindow("answers", window)} />
          </div>}
          {view.statuses.length > 0 && <div className="flex flex-col gap-1">
            <div className={artifactLabelClass}>Without an answer</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {view.statuses.map((count) => (
                <li key={JSON.stringify(count.drilldown.selector)} className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <span>{questionLabel(count.question)}</span>
                  <CountButton label={statusKeyLabel(count.status)} count={count.count} testId="or-task-status-count" drill={() => onDrill(count.drilldown, `${questionLabel(count.question)}: ${statusKeyLabel(count.status)}`)} />
                </li>
              ))}
            </ul>
            <ListPager name="statuses" page={stage.statuses} onWindow={(window) => onWindow("statuses", window)} />
          </div>}
          {view.disagreements.length > 0 && <div className="flex flex-col gap-1">
            <div className={artifactLabelClass}>Disagreement on one item</div>
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {view.disagreements.map((count) => (
                <li key={JSON.stringify(count.drilldown.selector)} className="flex flex-wrap items-center gap-2 text-xs text-[var(--text-secondary)]">
                  <span>{questionLabel(count.question)}</span>
                  <CountButton label="items" count={count.item_count} testId="or-task-disagreement-count" drill={() => onDrill(count.drilldown, `${questionLabel(count.question)}: disagreement`)} />
                </li>
              ))}
            </ul>
            <ListPager name="disagreements" page={stage.disagreements} onWindow={(window) => onWindow("disagreements", window)} />
          </div>}
          <div className="flex flex-wrap gap-1.5">
            <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => onDrill(stage.items, `${stageLabel(view.stage)}: every linked item`)} data-testid="or-task-items">All linked items</Button>
            {(stage.totals.superseded_items > 0 || stage.totals.superseded_answers > 0) && (
              <Button variant="secondary" size="xsmall" className="text-xs!" onClick={() => onDrill(stage.history, `${stageLabel(view.stage)}: older revisions and answers`)} data-testid="or-task-history">
                Older revisions and answers
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
