import { Button } from "../../../components/atoms/Button";
import { GradingConfigBrowser } from "./GradingConfigBrowser";
import { GradingConfigFeedback } from "../molecules/GradingConfigFeedback";
import { useGradingWorkflowTargets, useGradingConfiguration, useGradingConfigurationWrites } from "../../hooks/useGradingConfiguration";
export interface GradingConfigViewProps { readonly definitionId?: string | null; readonly version: number | null; readonly onNavigate: (version: number | null) => void }
export function GradingConfigRoute({ version, onNavigate, definitionId }: GradingConfigViewProps) {
  const targets = useGradingWorkflowTargets();
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
    <GradingConfigBrowser key={query.snapshot.revision} workflowTargets={targets.data} definitionId={definitionId} initial={query.snapshot.read} version={version} onNavigate={onNavigate} onReload={() => void query.reload()} onWrite={recordWrite} />
  </>;
}
