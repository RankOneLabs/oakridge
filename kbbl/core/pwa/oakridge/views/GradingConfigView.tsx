import { Button } from "../../components/atoms/Button";
import { GradingConfigBrowser } from "../components/organisms/GradingConfigBrowser";
import { GradingConfigFeedback } from "../components/molecules/GradingConfigFeedback";
import { useGradingConfiguration, useGradingConfigurationWrites } from "../hooks/useGradingConfiguration";
interface GradingConfigViewProps { readonly version: number | null; readonly onNavigate: (version: number | null) => void }
export function GradingConfigView({ version, onNavigate }: GradingConfigViewProps) {
  return <GradingConfigRoute key={version ?? "draft"} version={version} onNavigate={onNavigate} />;
}
function GradingConfigRoute({ version, onNavigate }: GradingConfigViewProps) {
  const query = useGradingConfiguration(version);
  const { recordWrite } = useGradingConfigurationWrites();
  if (query.snapshot === null) {
    if (query.isPending || query.isFetching || query.data?.ok) return <p className="p-6">Loading grading configuration…</p>;
    return <div className="grid gap-3 p-6"><h1>Grading configuration unavailable</h1>
    <GradingConfigFeedback feedback={query.data?.ok === false ? query.data.feedback : { kind: "transport_error", detail: query.error?.message ?? "Unavailable" }} />
    <Button onClick={() => void query.refetch()}>Retry</Button></div>;
  }
  return <>
    <GradingConfigFeedback feedback={query.reloadFeedback} />
    <GradingConfigBrowser key={query.snapshot.revision} initial={query.snapshot.read} version={version} onNavigate={onNavigate} onReload={() => void query.reload()} onWrite={recordWrite} />
  </>;
}
