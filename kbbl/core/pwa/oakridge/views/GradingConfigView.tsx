import { GradingConfigRoute, type GradingConfigViewProps } from "../components/organisms/GradingConfigRoute";
export function GradingConfigView({ version, onNavigate }: GradingConfigViewProps) {
  return <GradingConfigRoute key={version ?? "draft"} version={version} onNavigate={onNavigate} />;
}
