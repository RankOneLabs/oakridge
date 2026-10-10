import { WorkflowDefEditor } from "../components/organisms/WorkflowDefEditor";
interface Props { readonly cloneFromId: string | null; readonly onBack: () => void; readonly onCreated: () => void }
export function WorkflowDefEditorView({ cloneFromId, onBack, onCreated }: Props) {
  return <WorkflowDefEditor cloneFromId={cloneFromId} onBack={onBack} onCreated={onCreated} />;
}
