import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { TextArea } from "../../../components/atoms/TextArea";
import { Button } from "../../../components/atoms/Button";
import { readDefinitions, fetchOperatorDefinition } from "../../client";
import { usePromptVersions } from "../../hooks/usePromptVersions";
import { usePromptEditor } from "../../hooks/usePromptEditor";
import { selectPromptEditorActions, selectPromptReferences, selectPromptIsShared, promptFeedbackText } from "../../lib/prompt-editor";
import { PromptVersionHistory } from "../molecules/PromptVersionHistory";
import type { StageInspectorModel } from "../../lib/stage-inspector";
import type { OperatorPromptVersionListing } from "../../operator-contracts/http/prompt-versions";
interface PromptEditorProps { path: string; model: StageInspectorModel; onClose: () => void; onDirtyChange?: (isDirty: boolean) => void }
export function PromptEditor(props: PromptEditorProps) {
  const versions = usePromptVersions(props.path);
  if (versions.isPending) return <p role="status">Loading prompt versions…</p>;
  if (versions.error) return <p role="alert">{versions.error.message}</p>;
  if (!versions.data?.ok) return <p role="alert">{versions.data ? promptFeedbackText(versions.data.feedback) : "Unable to read prompt versions"}</p>;
  return <LoadedPromptEditor {...props} versions={versions.data.value} />;
}
interface LoadedPromptEditorProps extends PromptEditorProps {versions: OperatorPromptVersionListing}
function LoadedPromptEditor({path, model, onClose, onDirtyChange, versions}: LoadedPromptEditorProps) {
  const editor = usePromptEditor({path, definition: model.definition, versions,
    selection: model.selected_unit ? {kind: "unit", path: model.selected_unit.path, tab: "prompts"} : {kind: "stage", stage: model.name, tab: "prompts"}, onClose});
  useEffect(() => { onDirtyChange?.(editor.state.is_dirty); }, [onDirtyChange, editor.state.is_dirty]);
  const definitions = useQuery({queryKey: ["oakridge", "prompt-references", model.definition.definition_id], queryFn: async () => {
    const listed = await readDefinitions();
    const others = await Promise.all(listed.filter(item => item.definition_id !== model.definition.definition_id).map(item => fetchOperatorDefinition(item.definition_id)));
    return [...others, model.definition];
  }});
  const references = selectPromptReferences({path, definitions: definitions.data ?? [model.definition]});
  const actions = selectPromptEditorActions(editor.state, editor.is_busy);
  return <section aria-label="Prompt editor" className="rounded border border-[var(--border-muted)] p-3">
    <h3>Editing {path}</h3><p>Source: {path}</p>
    {selectPromptIsShared(references) && <p>Shared prompt: saving and publishing changes it for every use listed below.</p>}
    <h4>Used by</h4>
    {definitions.isPending && <p role="status">Loading prompt references…</p>}
    {definitions.error && <p role="alert">Unable to load all prompt references: {definitions.error.message}</p>}
    <ul>{references.map(reference => <li key={[reference.definition_id, reference.stage, reference.owner_kind, reference.owner_key, reference.mode].join(":")}>{reference.workflow} › {reference.stage} › {reference.owner_key} ({reference.mode}){reference.template && <> · from template {reference.template}</>}</li>)}</ul>
    <label>Prompt body<TextArea className="block" value={editor.state.body} disabled={editor.is_busy} onChange={event => editor.edit(event.target.value)} /></label>
    <p>{editor.state.is_dirty ? "Unsaved local edits" : editor.state.pending ? `Saved pending version ${editor.state.pending.digest}` : "No pending version"}</p>
    <div className="flex flex-wrap gap-2">
      <Button disabled={!actions.save} onClick={() => void editor.save()}>Save draft</Button>
      <Button disabled={!actions.validate} onClick={() => void editor.validate()}>Validate saved draft</Button>
      <Button disabled={!actions.publish} onClick={() => void editor.publish()}>Publish prompt</Button>
      <Button disabled={!actions.discard} onClick={editor.discard}>Discard local edits</Button>
      <Button disabled={!actions.close} onClick={editor.close}>Close editor</Button>
    </div>
    {editor.feedback && <div role="status" aria-live="polite" data-testid="prompt-editor-feedback" data-kind={editor.feedback.kind} className="rounded border border-[var(--border-muted)] bg-[var(--bg-elevated)] p-3 break-words">
      <p>{promptFeedbackText(editor.feedback)}</p>
      {editor.feedback.kind === "validation_failed" && <ul>{editor.feedback.issues.map((issue, index) => <li key={index}>{issue.path.join(".")}: {issue.detail}</li>)}</ul>}
    </div>}
    <PromptVersionHistory versions={versions} />
  </section>;
}
