import { Button } from "../../../components/atoms/Button";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";

interface Props { readonly error: unknown; readonly isRetrying: boolean; readonly onRetry: () => void }

export function PagingReadError({ error, isRetrying, onRetry }: Props) {
  return <FeedbackMessage tone="danger">
    <span>Could not load this page: {error instanceof Error ? error.message : "observation did not answer"}</span>
    <Button variant="secondary" size="xsmall" className="ml-2" disabled={isRetrying} onClick={onRetry}>Retry</Button>
  </FeedbackMessage>;
}
