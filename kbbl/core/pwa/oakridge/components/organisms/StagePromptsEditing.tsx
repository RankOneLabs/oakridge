import { useState } from "react";
import { StagePromptsSection } from "../molecules/StagePromptsSection";
import { PromptEditor } from "./PromptEditor";
import type { StageSectionProps } from "../../lib/stage-inspector";

/** Owns which prompt is open for editing and whether switching away discards unsaved edits. */
export function StagePromptsEditing({ model }: StageSectionProps) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [isDirty, setDirty] = useState(false);
  function requestEdit(path: string) {
    if (openPath !== null && openPath !== path && isDirty && !window.confirm("Discard unsaved local edits and open another view?")) return;
    setOpenPath(path);
  }
  function close() { setDirty(false); setOpenPath(null); }
  const editor = openPath === null ? null
    : <PromptEditor key={openPath} path={openPath} model={model} onClose={close} onDirtyChange={setDirty} />;
  return <StagePromptsSection model={model} openPath={openPath} onEditPrompt={requestEdit} editor={editor} />;
}
