import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { useStageOverview } from "../../hooks/useStageOverview";
import { selectEvaluationQuestions, selectEvaluationSelections, selectIsGradingReadPartial, type StageEvaluation, type StageExecution, type StageInputs, type StageRead } from "../../lib/stage-overview";
import type { RunWorkspacePane } from "../../lib/run-workspace";
import { useGradingVisibility } from "../../state/gradingVisibility";
import { RelationshipLinks } from "../molecules/RelationshipLinks";
import { StructuredValue } from "../molecules/StructuredValue";
import { ItemGradeAction } from "./ItemGradeAction";
import { ShowAutomaticGrades } from "./ShowAutomaticGrades";
import type { ObservationItemStatusResponse } from "../../grading-contracts/storage/grading-record-store";

interface Props { runId: string; unitId: string; onOpenBeside: (pane: RunWorkspacePane) => void }
export function StageOverview({ runId, unitId, onOpenBeside }: Props) {
  const read = useStageOverview(runId, unitId);
  if (read.units.isError) return <FeedbackMessage tone="danger">Stage overview unavailable.</FeedbackMessage>;
  if (!read.units.data) return <FeedbackMessage>Loading stage overview…</FeedbackMessage>;
  if (!read.source || !read.inputs || !read.execution || !read.evaluation) return <FeedbackMessage>Recorded unit unresolved: {unitId}</FeedbackMessage>;
  return <StageOverviewContent runId={runId} label={read.source.unit.label} inputs={read.inputs} execution={read.execution} evaluation={read.evaluation}
    artifactState={read.artifacts.isError ? "unavailable" : read.artifacts.data ? "loaded" : "pending"} onOpenBeside={onOpenBeside} />;
}
interface ContentProps {
  runId: string; label: string; inputs: StageInputs; execution: StageExecution; evaluation: StageEvaluation;
  artifactState: "pending" | "unavailable" | "loaded"; onOpenBeside: Props["onOpenBeside"];
}
export function StageOverviewContent({ runId, label, inputs, execution, evaluation, artifactState, onOpenBeside }: ContentProps) {
  return <article className="flex flex-col gap-6 p-3" data-testid="or-stage-overview">
    <h2 className="text-lg font-semibold">{label}</h2>
    <section className="flex flex-col gap-3" aria-label="Inputs"><h3>Inputs</h3>
      <details><summary>Resolved stage input</summary><StructuredValue value={inputs.resolved_input} /></details>
      <RelationshipLinks links={inputs.links} onOpen={onOpenBeside} />
      {inputs.attempts.length === 0 && <p>No attempts recorded.</p>}
      {inputs.attempts.map((attempt) => <section key={attempt.id}><h4>{attempt.worker} #{attempt.number}</h4>
        {attempt.intent ? <><h5>Prompt</h5>{attempt.intent.prompt ? <Button variant="secondary" size="xsmall" onClick={() => onOpenBeside({ kind: "prompt", unit_id: attempt.unit_id, attempt_id: attempt.id })}>Prompt {attempt.intent.prompt.path} · {attempt.intent.prompt.digest}</Button> : <p>This worker has no prompt.</p>}<details><summary>Recorded inputs and engine inputs</summary><StructuredValue value={attempt.intent.inputs} /><h5>Engine inputs</h5><StructuredValue value={attempt.intent.engine_inputs} /></details></> : <p>Intent not captured.</p>}
      </section>)}
    </section>
    <section className="flex flex-col gap-3" aria-label="Execution and outputs"><h3>Execution and outputs</h3>
      {execution.attempts.length === 0 && <p>No attempts recorded.</p>}
      {execution.attempts.map((attempt) => <section key={attempt.id}><h4>{attempt.worker} #{attempt.number} · {attempt.status} · {attempt.mode} · {attempt.is_current ? "current" : "superseded"}</h4>
        <StructuredValue value={attempt.cause} />{attempt.failure && <StructuredValue value={attempt.failure} />}
        {attempt.session?.kind === "session" ? <Button variant="secondary" size="xsmall" onClick={() => attempt.session && onOpenBeside(attempt.session)}>Session {attempt.session.session_id}</Button> : <p>Session not captured.</p>}
      </section>)}
      <h4>Produced artifacts and revisions</h4>
      {artifactState !== "loaded" && <p>Revision history {artifactState === "pending" ? "loading…" : "unavailable."}</p>}
      {execution.outputs.length === 0 && <p>No artifacts declared.</p>}
      {execution.outputs.map((output) => <section key={output.key}><h5>{output.key} · {output.schema}</h5>
        {artifactState === "loaded" && output.revisions.length === 0 && <p>No revisions recorded.</p>}
        {output.revisions.map(({ revision, pane, links }) => <div key={revision.id} className="flex flex-col gap-2">
          <Button variant="secondary" size="xsmall" onClick={() => onOpenBeside(pane)}>v{revision.number} · {revision.id}</Button><RelationshipLinks links={links} onOpen={onOpenBeside} />
        </div>)}
      </section>)}
      <h4>Reviews available now</h4>{execution.reviews.length ? <details><summary>{execution.reviews.length} review decisions available</summary><StructuredValue value={execution.reviews} /></details> : <p>No reviews available.</p>}
      <h4>Recorded decisions</h4>{execution.recorded_decisions.length ? <details><summary>{execution.recorded_decisions.length} decisions recorded</summary><StructuredValue value={execution.recorded_decisions} /></details> : <p>No decisions recorded.</p>}
    </section>
    <section className="flex flex-col gap-3" aria-label="Evaluation"><h3>Evaluation</h3>
      <ReadNotice name="Grading stages" read={evaluation.stages} />
      {evaluation.stages.state === "loaded" && <StructuredValue value={evaluation.stages.value} />}
      <ReadNotice name="Findings" read={evaluation.findings} /><ReadNotice name="Tasks" read={evaluation.tasks} />
      {evaluation.tasks.state === "loaded" && evaluation.tasks.value.map((task) => <Button key={task.logical_item_id} variant="secondary" size="xsmall" onClick={() => onOpenBeside({ kind: "task", task_id: task.producer_local_id })}>Task {task.producer_local_id}</Button>)}
      <RelationshipLinks links={evaluation.links} onOpen={onOpenBeside} />
      {evaluation.statuses.map((status, index) => status.state === "loaded" ? <EvaluationItem key={status.value.item.occurrence_id} runId={runId} status={status.value} onOpenBeside={onOpenBeside} /> : <ReadNotice key={index} name="Item grading" read={status} />)}
    </section>
  </article>;
}
interface ReadNoticeProps {
  readonly name: string;
  readonly read: StageRead<readonly unknown[] | ObservationItemStatusResponse>;
}
function ReadNotice({ name, read }: ReadNoticeProps) {
  if (read.state !== "loaded") return <p>{name}: {read.state === "pending" ? "loading…" : "unavailable."}</p>;
  if (read.is_partial) return <p>{name}: partial read; open a linked viewer for paged detail.</p>;
  return Array.isArray(read.value) && read.value.length === 0 ? <p>{name}: none recorded for this unit.</p> : null;
}
interface EvaluationItemProps {
  readonly runId: string;
  readonly status: ObservationItemStatusResponse;
  readonly onOpenBeside: Props["onOpenBeside"];
}
function EvaluationItem({ runId, status, onOpenBeside }: EvaluationItemProps) {
  const revealed = useGradingVisibility((state) => state.revealed_item_keys);
  const questions = selectEvaluationQuestions(status, revealed);
  const selections = selectEvaluationSelections(status);
  const isPartial = selectIsGradingReadPartial(status);
  return <section className="flex flex-col gap-2"><h4>{status.item.item_path}</h4>
    <ShowAutomaticGrades selections={selections} />
    {questions.length === 0 && <p>No questions pinned.</p>}
    {questions.map((question) => <div key={`${question.question.question_id}:${question.evidence.evidence_set_id}`}><ItemGradeAction runId={runId} selection={question.selection} onOpenItem={(selection) => onOpenBeside({ kind: "item", selection, question: question.question })} /><StructuredValue value={question} />{question.answers === null && <p>Other answers and results are hidden.</p>}</div>)}
    {isPartial && <p>Partial grading detail; open the item to browse all pages.</p>}
  </section>;
}
