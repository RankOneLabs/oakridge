import { HandoffProvenance } from "./HandoffProvenance";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { useOperatorUnits } from "../../hooks/useOperatorUnits";
import { useExecutedPrompt } from "../../hooks/useExecutedPrompt";
import { selectPromptView, type ExecutedPromptRead, type PromptView } from "../../lib/prompt-view";
import { StructuredValue } from "../molecules/StructuredValue";

interface Props { runId: string; unitId: string; attemptId: string }
export function PromptViewer({ runId, unitId, attemptId }: Props) {
  const units = useOperatorUnits(runId);
  const view = selectPromptView({ units: units.data ?? [], unit_id: unitId, attempt_id: attemptId });
  const executed = useExecutedPrompt(view?.session_id ?? null);
  if (units.isError) return <FeedbackMessage tone="danger">Prompt provenance unavailable.</FeedbackMessage>;
  if (!units.data) return <FeedbackMessage>Loading prompt provenance…</FeedbackMessage>;
  if (!view) return <FeedbackMessage>Recorded attempt unresolved: {attemptId}</FeedbackMessage>;
  return <><HandoffProvenance runId={runId} unitId={unitId} attemptId={attemptId} /><PromptViewerContent view={view} executed={view.session_id === null ? { state: "not_retained" } : executed.data ?? null} isExecutedError={executed.isError} /></>;
}
interface ContentProps { view: PromptView; executed: ExecutedPromptRead | null; isExecutedError?: boolean }
/** Read-only. A catalog entry at the same path is never a historical template source. */
export function PromptViewerContent({ view, executed, isExecutedError = false }: ContentProps) {
  return <article className="flex flex-col gap-5 p-3" data-testid="or-prompt-viewer">
    <header><h2 className="text-lg font-semibold">Worker prompt</h2><dl className="text-sm">
      <dt>Attempt</dt><dd className="m-0 break-all font-mono">{view.attempt_id}</dd>
      <dt>Worker</dt><dd className="m-0">{view.worker}</dd><dt>Stage</dt><dd className="m-0">{view.stage ?? "Not recorded"}</dd>
    </dl></header>
    <section aria-label="Template" className="flex flex-col gap-2"><h3 className="font-semibold">Template</h3>
      {view.template ? <><dl className="text-sm"><dt>Prompt identifier</dt><dd className="m-0 break-all">{view.template.identifier}</dd>
        <dt>Source path</dt><dd className="m-0 break-all font-mono">{view.template.path}</dd>
        <dt>Pinned digest</dt><dd className="m-0 break-all font-mono">{view.template.digest}</dd></dl>
        <FeedbackMessage>Pinned template content is not available by this exact digest. Only the recorded template provenance is available.</FeedbackMessage></>
        : <FeedbackMessage>No prompt template was recorded for this attempt.</FeedbackMessage>}
    </section>
    <section aria-label="Inputs" className="flex flex-col gap-2"><h3 className="font-semibold">Inputs</h3>
      {view.inputs ? <><h4>Resolved inputs</h4><StructuredValue value={view.inputs.inputs} /><h4>Engine inputs</h4><StructuredValue value={view.inputs.engine_inputs} /></>
        : <FeedbackMessage>Attempt intent was not captured.</FeedbackMessage>}
    </section>
    <section aria-label="Executed content" className="flex flex-col gap-2"><h3 className="font-semibold">Executed content</h3>
      {isExecutedError ? <FeedbackMessage tone="danger">Executed content unavailable: the session read failed.</FeedbackMessage>
        : executed === null ? <FeedbackMessage>Loading executed content…</FeedbackMessage>
        : executed.state === "not_retained" ? <FeedbackMessage>Executed content was not retained for this attempt.</FeedbackMessage>
        : <><h4 className="m-0 text-sm font-medium">Session context</h4>
          <FeedbackMessage>This is the session-wide transcript. Shared sessions can include other attempts and later tasks. The selected attempt’s template and inputs are shown above. These turns crossed the dispatch boundary; delivery or completion can be uncertain.</FeedbackMessage>
          {executed.turns.map((turn) => <div key={turn.turn_id} className="flex flex-col gap-1"><h5 className="m-0 break-all text-xs text-[var(--text-muted)]">{turn.turn_id} · {turn.created_at}</h5>
            <pre className="m-0 whitespace-pre-wrap break-words rounded-md border border-[var(--border-decorative)] p-3 text-xs">{turn.text}</pre></div>)}</>}
    </section>
  </article>;
}
