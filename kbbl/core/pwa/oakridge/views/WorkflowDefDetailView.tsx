import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";

interface WorkflowDefDetailViewProps {
  definitionId: string;
  onBack: () => void;
}

export function WorkflowDefDetailView(props: WorkflowDefDetailViewProps) {
  return <WorkflowDefDetail {...props} />;
}
