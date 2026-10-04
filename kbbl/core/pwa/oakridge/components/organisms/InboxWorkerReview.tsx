import { useArtifact } from "../../hooks/useArtifact";
import { WorkerReviewActions } from "./WorkerReviewActions";
interface InboxWorkerReviewProps { readonly artifactId: string; readonly runId: string }
export function InboxWorkerReview({ artifactId, runId }: InboxWorkerReviewProps) {
  const artifact = useArtifact(artifactId);
  if (artifact.isPending) return <p>Loading current review…</p>;
  if (artifact.isError) return <p role="alert">Could not load the current review.</p>;
  if (artifact.data?.review_error) return <p role="alert">{artifact.data.review_error.detail}</p>;
  const context = artifact.data?.review_context;
  return context ? <WorkerReviewActions key={`${context.cohort_id}:${context.expected_version}:${context.worker}`} context={context} runId={runId} />
    : <p>This output has no current review action.</p>;
}
