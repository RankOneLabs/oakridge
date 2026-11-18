import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { useRunUsage } from "../../hooks/useRunUsage";
import { RunUsageSummary } from "../molecules/RunUsageSummary";

interface Props { runId: string }
/** The run's Usage pane body; the pane chrome supplies its "Usage" heading. */
export function RunUsagePanel({ runId }: Props) {
  const usage = useRunUsage(runId);
  return <section aria-label="Run usage">
    {usage.isPending && <FeedbackMessage tone="muted">Loading usage…</FeedbackMessage>}
    {usage.isError && <FeedbackMessage>Usage unavailable: {usage.error.message}</FeedbackMessage>}
    {usage.data ? <RunUsageSummary usage={usage.data} /> : <p className="m-0 text-sm" data-testid="usage-coverage">Coverage: unavailable</p>}
  </section>;
}
