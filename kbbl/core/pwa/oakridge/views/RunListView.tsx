import { RunList } from "../components/organisms/RunList";

interface RunListViewProps {
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  onNewProject: () => void;
  onReviewInbox?: () => void;
  onSelectArtifact?: (id: string) => void;
  runAttentionCounts?: ReadonlyMap<string, number>;
}

export function RunListView(props: RunListViewProps) {
  return <RunList {...props} />;
}
