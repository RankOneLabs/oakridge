import { WorkflowDefList } from "../components/organisms/WorkflowDefList";
import type { WorkflowDefSummary } from "../project-types";

interface WorkflowDefListViewProps {
  onSelect: (definition: WorkflowDefSummary) => void;
}

export function WorkflowDefListView(props: WorkflowDefListViewProps) {
  return <WorkflowDefList {...props} />;
}
