import { useId, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { OperatorArtifactReviewContext } from "../../review-command-types";
import type { OperatorRequest } from "../../review-command-types";
import { Button } from "../../../components/atoms/Button";
import { randomUuid } from "../../../lib/random-uuid";
import { submitCohortRequest } from "../../client";
import { selectWorkerReviewActions, type WorkerReviewAction } from "../../lib/worker-review-actions";

interface WorkerReviewActionsProps { readonly context: OperatorArtifactReviewContext; readonly runId: string }
export function WorkerReviewActions({ context, runId }: WorkerReviewActionsProps) {
  const actionPrefix = useId();
  const client = useQueryClient();
  const [feedbackAction, setFeedbackAction] = useState<Extract<WorkerReviewAction, { kind: "feedback" }> | null>(null);
  const [feedback, setFeedback] = useState("");
  const [completed, setCompleted] = useState(false);
  const identities = useRef(new Map<string, string>());
  const mutation = useMutation({ mutationFn: (request: OperatorRequest) => {
    const key = JSON.stringify({ context, request });
    let id = identities.current.get(key);
    if (!id) { id = randomUuid(); identities.current.set(key, id); }
    return submitCohortRequest({ cohort_id: context.cohort_id, expected_version: context.expected_version, request, id });
  }, onSuccess: () => {
    setCompleted(true);
    void client.invalidateQueries({ queryKey: ["oakridge", "run", runId] });
    void client.invalidateQueries({ queryKey: ["oakridge", "artifact"] });
    void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] });
  } });
  if (completed) return <p role="status" data-testid="or-decision-success">Decision recorded.</p>;
  return <section className="flex flex-col gap-3" data-testid="or-decision-actions">
    <div className="flex flex-wrap gap-2">{selectWorkerReviewActions(context).map((action, index) => <div key={action.label} className="flex max-w-sm flex-col gap-1">
      <Button variant="secondary" aria-describedby={`${actionPrefix}-${index}`} disabled={mutation.isPending}
        onClick={() => action.kind === "immediate" ? mutation.mutate(action.request) : setFeedbackAction(action)}>{action.label}</Button>
      <p id={`${actionPrefix}-${index}`} className="text-sm text-[var(--text-muted)]">{action.consequence}</p>
    </div>)}</div>
    {feedbackAction && <form onSubmit={(event) => { event.preventDefault(); if (feedback.trim()) mutation.mutate(feedbackAction.request(feedback.trim())); }} className="flex flex-col gap-2">
      <label htmlFor="worker-feedback">{feedbackAction.label}</label>
      <textarea id="worker-feedback" value={feedback} onChange={(event) => setFeedback(event.target.value)} required disabled={mutation.isPending}
        className="min-h-24 rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] p-3" />
      <Button variant="primary" type="submit" disabled={mutation.isPending || !feedback.trim()}>Send feedback</Button>
    </form>}
    {mutation.isError && <p role="alert">{mutation.error instanceof Error ? mutation.error.message : "Decision failed"}</p>}
  </section>;
}
