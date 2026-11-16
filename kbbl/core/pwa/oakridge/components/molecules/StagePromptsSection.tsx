import { Fragment, useState, type ReactNode } from "react";
import { Button } from "../../../components/atoms/Button";
import { stageElementHref, stageElementId, type StageSectionProps, type StageInspectorModel } from "../../lib/stage-inspector";
import { selectPromptRows } from "../../lib/prompt-inspector";
import { LetExpression } from "./LetExpression";
export interface PromptEditorSlotProps {
  path: string;
  model: StageInspectorModel;
  onClose: () => void;
  onDirtyChange: (isDirty: boolean) => void;
}
export interface StagePromptsSectionProps extends StageSectionProps {
  renderPromptEditor?: (props: PromptEditorSlotProps) => ReactNode;
}
export function StagePromptsSection({ model, renderPromptEditor }: StagePromptsSectionProps) {
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [isDirty, setDirty] = useState(false);
  return <section aria-label="Prompts" className="rounded border border-[var(--border-muted)] p-3">
    <h3>Prompts</h3>
    {selectPromptRows(model).map(row => <article key={row.id} id={stageElementId({ stage: model.name, kind: "prompt", name: row.id })} tabIndex={-1}>
      <h4>{row.owner.key}</h4>
      <Button disabled={!renderPromptEditor} aria-label={`Edit ${row.path}`} onClick={() => { if (openPath === null || openPath === row.path || !isDirty || window.confirm("Discard unsaved local edits and open another view?")) setOpenPath(row.path); }}>Edit prompt</Button>
      <dl><dt>Used by</dt><dd>{row.owner.kind} {row.owner.key}{row.owner.template && <> from template {row.owner.template}</>}</dd>
      <dt>Mode</dt><dd>{row.mode}</dd><dt>Source</dt><dd>{row.path}</dd><dt>Digest</dt><dd>{row.digest}</dd></dl>
      {row.body !== null && <pre>{row.body}</pre>}
      <h5>Inputs</h5><dl>{row.inputs.map(input => <div key={input.name}><dt>inputs.{input.name}</dt><dd><LetExpression model={model} expression={input.expression} /></dd></div>)}</dl>
      <p>Produces {row.produces.map(name => <a key={name} className="mr-2" href={stageElementHref(model, {kind: "artifact", name})}>{name}</a>)}</p>
      {row.owner.kind === "review" && <p>Reviews <a href={stageElementHref(model, {kind: "artifact", name: row.owner.of})}>{row.owner.of}</a></p>}
    </article>)}
    {openPath && renderPromptEditor && <Fragment key={openPath}>{renderPromptEditor({path: openPath, model, onDirtyChange: setDirty, onClose: () => { setDirty(false); setOpenPath(null); }})}</Fragment>}
    {model.sources.map(({kind, name, label, content}) => <details key={kind + ":" + name} id={stageElementId({stage: model.name, kind, name})} tabIndex={-1}><summary>{label}</summary><pre>{content}</pre></details>)}
  </section>;
}
