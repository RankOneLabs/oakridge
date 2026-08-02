import { RunDetail } from "../components/organisms/RunDetail";

interface RunDetailViewProps {
  runId: string;
  onBack: () => void;
  onSelectArtifact: (artifactId: string) => void;
}

export function RunDetailView(props: RunDetailViewProps) {
  return <RunDetail {...props} />;
}
