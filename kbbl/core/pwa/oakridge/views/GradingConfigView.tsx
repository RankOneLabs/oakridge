import { GradingConfigRoute, type GradingConfigViewProps } from "../components/organisms/GradingConfigRoute";
export function GradingConfigView({ version, onNavigate, definitionId }: GradingConfigViewProps) {
  return <GradingConfigRoute key={`${version ?? "draft"}/${definitionId ?? ""}`} definitionId={definitionId} version={version} onNavigate={onNavigate} />;
}
