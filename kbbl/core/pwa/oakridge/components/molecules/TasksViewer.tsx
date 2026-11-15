import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { ViewerProps } from "../../artifactRegistry";
import { parseTasks, type Task } from "../../lib/tasks";
import { ArtifactSection } from "./ArtifactSection";
import { ExpandableText } from "./ExpandableText";
import { ArtifactItemGrade } from "./ArtifactItemGrade";
import { selectFindingSelections } from "../../lib/grading";

type Editor = NonNullable<ViewerProps["edit"]> | null;

function TaskText({ anchor, value, editor, renderEditableText, isProse = false }: { anchor: string; value: string; editor: Editor; renderEditableText?: ViewerProps["renderEditableText"]; isProse?: boolean }) {
  if (editor && renderEditableText) return renderEditableText({ anchor, value, edit: editor, isMultiline: isProse });
  return isProse
    ? <ExpandableText text={value} className="text-sm text-[var(--text-secondary)]" />
    : <code className="or-code">{value}</code>;
}

function RequirementLinks({ task, anchor, editor, renderEditableText, renderTaskEditControls }: { task: Task; anchor: string; editor: Editor; renderEditableText?: ViewerProps["renderEditableText"]; renderTaskEditControls?: ViewerProps["renderTaskEditControls"] }) {
  const listAnchor = `${anchor}/requirement_ids`;

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="or-task-requirements">
      <span className="text-xs text-[var(--text-muted)]">Requirements</span>
      {task.requirement_ids.length === 0 && <Chip tone="muted">Unlinked</Chip>}
      {task.requirement_ids.map((id, index) => (
        <span key={`${index}-${id}`} className="inline-flex items-center gap-1">
          <TaskText renderEditableText={renderEditableText} anchor={`${listAnchor}/${index}`} value={id} editor={editor} />
          {editor && <Button variant="secondary" size="xsmall" aria-label={`Remove requirement ${id}`} disabled={editor.isPending}
            onClick={() => editor.onEdit(listAnchor, task.requirement_ids, task.requirement_ids.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>}
        </span>
      ))}
      {editor && renderTaskEditControls?.({ task, anchor, edit: editor })}
    </div>
  );
}

export function TasksViewer({ body, edit, renderEditableText, renderTaskEditControls, source, onOpenItem, itemGrading }: ViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const parsed = parseTasks(body);
  if (!parsed.ok) {
    return <div className="or-error" role="alert">This tasks artifact does not match the registered contract: {parsed.error.field}.</div>;
  }
  const editor: Editor = isEditing && edit?.enabled ? edit : null;

  return (
    <article className="flex flex-col gap-5" data-testid="or-tasks-viewer">
      <header className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Spec tasks</h2>
        {edit?.enabled && <div className="flex items-center gap-2">
          {editor?.isPending && <span className="text-xs text-[var(--text-muted)]">Saving…</span>}
          <Button variant={isEditing ? "primary" : "secondary"} size="xsmall" className="text-xs!" aria-pressed={isEditing} onClick={() => setIsEditing(!isEditing)}>
            {isEditing ? "Done editing" : "Edit tasks"}
          </Button>
        </div>}
      </header>
      {itemGrading?.renderShowAll(selectFindingSelections(source, parsed.value.tasks.map((_, index) => `/tasks/${index}`)))}
      <ArtifactSection title={`Tasks (${parsed.value.tasks.length})`} testId="or-tasks-list">
        {parsed.value.tasks.length === 0
          ? <p className="text-sm text-[var(--text-muted)]">No tasks listed.</p>
          : <ol className="m-0 list-none divide-y divide-[var(--border-decorative)] p-0">
            {parsed.value.tasks.map((task, index) => <li key={`${index}-${task.id}`} className="flex flex-col gap-2 py-3">
              <div className="flex items-center justify-between gap-2">
                <TaskText renderEditableText={renderEditableText} anchor={`/tasks/${index}/id`} value={task.id} editor={editor} />
                <ArtifactItemGrade source={source} itemPath={`/tasks/${index}`} itemGrading={itemGrading} onOpenItem={onOpenItem} />
              </div>
              <TaskText renderEditableText={renderEditableText} anchor={`/tasks/${index}/description`} value={task.description} editor={editor} isProse />
              <RequirementLinks renderEditableText={renderEditableText} renderTaskEditControls={renderTaskEditControls} task={task} anchor={`/tasks/${index}`} editor={editor} />
            </li>)}
          </ol>}
      </ArtifactSection>
    </article>
  );
}
