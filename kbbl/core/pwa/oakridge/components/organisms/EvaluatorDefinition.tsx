import { GradingReadError } from "../../client-grading";
import { useEvaluatorDefinition } from "../../hooks/useEvaluatorDefinition";

/** Mounted only inside revealed answers, including historical evaluators. */
interface EvaluatorDefinitionProps {
  readonly evaluatorId: string;
}
export function EvaluatorDefinition({ evaluatorId }: EvaluatorDefinitionProps) {
  const read = useEvaluatorDefinition(evaluatorId);
  return <section className="flex flex-col gap-1 rounded-md border border-[var(--border-decorative)] p-2" data-testid="or-evaluator-definition">
    <h4 className="m-0 break-all text-xs font-medium">Pinned evaluator <code>{evaluatorId}</code></h4>
    {read.isError ? <p className="m-0 text-xs text-[var(--text-muted)]">{read.error instanceof GradingReadError && read.error.status === 404 ? "Pinned evaluator definition unavailable (not retained)." : "Pinned evaluator definition unavailable: the read failed."}</p>
      : !read.data ? <p className="m-0 text-xs">Loading evaluator definition…</p>
      : <><dl className="m-0 text-xs"><dt>Runner / backend</dt><dd className="m-0">{read.data.backend_kind} · {read.data.kind}</dd>
        <dt>Model</dt><dd className="m-0">{read.data.model ?? "Not specified"}</dd></dl>
        <h5 className="m-0 text-xs font-medium">Instructions</h5><pre className="m-0 whitespace-pre-wrap break-words text-xs">{read.data.instruction_text}</pre></>}
  </section>;
}
