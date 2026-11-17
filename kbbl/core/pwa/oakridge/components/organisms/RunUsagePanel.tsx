import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";
import { useRunUsage } from "../../hooks/useRunUsage";
import { RunUsageSummary } from "../molecules/RunUsageSummary";

interface Props { runId: string }
export function RunUsagePanel({ runId }: Props) {
  const usage = useRunUsage(runId);
  return <section className="shrink-0 border-b border-[var(--border-decorative)] p-3" aria-label="Run usage">
    <h2 className="m-0 mb-2 text-sm font-semibold">Usage</h2>
    {usage.isPending && <FeedbackMessage tone="muted">Loading usage…</FeedbackMessage>}
    {usage.isError && <FeedbackMessage>Usage unavailable: {usage.error.message}</FeedbackMessage>}
    {usage.data ? <RunUsageSummary usage={usage.data} /> : <p className="m-0 text-sm" data-testid="usage-coverage">Coverage: unavailable</p>}
  </section>;
}
