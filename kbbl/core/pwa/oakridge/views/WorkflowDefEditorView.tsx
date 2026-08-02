import { WorkflowDefEditor } from "../components/organisms/WorkflowDefEditor";

interface WorkflowDefEditorViewProps {
  cloneFromId: string | null;
  onBack: () => void;
  onCreated: () => void;
}

export function WorkflowDefEditorView(props: WorkflowDefEditorViewProps) {
  return <WorkflowDefEditor {...props} />;
}
