import { Button } from "../../components/atoms/Button";
import { GradingConfigBrowser } from "../components/organisms/GradingConfigBrowser";
import { GradingConfigFeedback } from "../components/molecules/GradingConfigFeedback";
import { useGradingConfiguration } from "../hooks/useGradingConfiguration";
interface GradingConfigViewProps { readonly version: number | null; readonly onNavigate: (version: number | null) => void }
export function GradingConfigView({ version, onNavigate }: GradingConfigViewProps) {
  const query = useGradingConfiguration(version);
  if (query.isPending || query.isFetching) return <p className="p-6">Loading grading configuration…</p>;
  if (query.isError || !query.data.ok) return <div className="grid gap-3 p-6"><h1>Grading configuration unavailable</h1>
    <GradingConfigFeedback feedback={query.data?.ok === false ? query.data.feedback : { kind: "transport_error", detail: query.error?.message ?? "Unavailable" }} />
    <Button onClick={() => void query.refetch()}>Retry</Button></div>;
  return <GradingConfigBrowser key={`${version}:${query.dataUpdatedAt}`} initial={query.data.value} version={version} onNavigate={onNavigate} onReload={() => void query.refetch()} />;
}
