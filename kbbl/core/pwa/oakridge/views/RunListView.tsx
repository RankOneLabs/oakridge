import { RunList } from "../components/organisms/RunList";

interface RunListViewProps {
  onSelectRun: (id: string) => void;
  onNewRun: () => void;
  onNewProject: () => void;
}

export function RunListView(props: RunListViewProps) {
  return <RunList {...props} />;
}
