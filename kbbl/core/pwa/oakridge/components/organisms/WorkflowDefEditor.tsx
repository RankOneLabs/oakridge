import { OperatorDefinitionEditorView } from "../../views/OperatorDefinitionEditorView";
interface Props { readonly cloneFromId: string | null; readonly onBack: () => void; readonly onCreated: () => void }
export function WorkflowDefEditor({ cloneFromId, onBack, onCreated }: Props) {
  return <OperatorDefinitionEditorView cloneFromId={cloneFromId} onBack={onBack} onPinned={onCreated} />;
}
