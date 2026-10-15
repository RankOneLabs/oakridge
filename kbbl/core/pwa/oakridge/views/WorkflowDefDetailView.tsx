import { WorkflowDefDetail } from "../components/organisms/WorkflowDefDetail";

interface WorkflowDefDetailViewProps {
  definitionId: string;
  onBack: () => void;
  onClone: () => void;
}

export function WorkflowDefDetailView(props: WorkflowDefDetailViewProps) {
  return <WorkflowDefDetail {...props} />;
}
