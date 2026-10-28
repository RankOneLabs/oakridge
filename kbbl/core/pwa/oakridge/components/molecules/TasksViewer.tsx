import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { ViewerProps } from "../../artifactRegistry";
import { parseTasks, type Task } from "../../lib/tasks";
import { ArtifactSection } from "./ArtifactSection";
import { EditableBriefText } from "./EditableBriefText";
import { ExpandableText } from "./ExpandableText";

type Editor = NonNullable<ViewerProps["edit"]> | null;

function TaskText({ anchor, value, editor, isProse = false }: { anchor: string; value: string; editor: Editor; isProse?: boolean }) {
  if (editor) return <EditableBriefText anchor={anchor} value={value} edit={editor} isMultiline={isProse} />;
  return isProse
    ? <ExpandableText text={value} className="text-sm text-[var(--text-secondary)]" />
    : <code className="or-code">{value}</code>;
}

function RequirementLinks({ task, anchor, editor }: { task: Task; anchor: string; editor: Editor }) {
  const [isAdding, setIsAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const listAnchor = `${anchor}/requirement_ids`;
  const add = () => {
    const id = draft.trim();
    if (id) editor?.onEdit(listAnchor, task.requirement_ids, [...task.requirement_ids, id]);
    setDraft("");
    setIsAdding(false);
  };

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="or-task-requirements">
      <span className="text-xs text-[var(--text-muted)]">Requirements</span>
      {task.requirement_ids.length === 0 && <Chip tone="muted">Unlinked</Chip>}
      {task.requirement_ids.map((id, index) => (
        <span key={`${index}-${id}`} className="inline-flex items-center gap-1">
          <TaskText anchor={`${listAnchor}/${index}`} value={id} editor={editor} />
          {editor && <Button variant="secondary" size="xsmall" aria-label={`Remove requirement ${id}`} disabled={editor.isPending}
            onClick={() => editor.onEdit(listAnchor, task.requirement_ids, task.requirement_ids.filter((_, itemIndex) => itemIndex !== index))}>Remove</Button>}
        </span>
      ))}
      {editor && (isAdding
        ? <span className="inline-flex items-center gap-1">
          <input aria-label="New requirement ID" className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-surface)] px-2 py-1 text-sm" value={draft}
            disabled={editor.isPending} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") add(); }} />
          <Button variant="secondary" size="xsmall" disabled={editor.isPending || !draft.trim()} onClick={add}>Save link</Button>
          <Button variant="secondary" size="xsmall" onClick={() => setIsAdding(false)}>Cancel</Button>
        </span>
        : <Button variant="secondary" size="xsmall" disabled={editor.isPending} onClick={() => setIsAdding(true)}>Add link</Button>)}
    </div>
  );
}

export function TasksViewer({ body, edit }: ViewerProps) {
  const [isEditing, setIsEditing] = useState(false);
  const parsed = parseTasks(body);
  if (!parsed.ok) {
    return <div className="or-error" role="alert">This tasks artifact does not match the registered contract: {parsed.error.field}.</div>;
  }
  const editor: Editor = isEditing && edit?.enabled ? edit : null;

  return (
    <article className="flex flex-col gap-5" data-testid="or-tasks-viewer">
      <header className="flex items-center justify-between gap-2">
        <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Tasks</h2>
        {edit?.enabled && <div className="flex items-center gap-2">
          {editor?.isPending && <span className="text-xs text-[var(--text-muted)]">Saving…</span>}
          <Button variant={isEditing ? "primary" : "secondary"} size="xsmall" className="text-xs!" aria-pressed={isEditing} onClick={() => setIsEditing(!isEditing)}>
            {isEditing ? "Done editing" : "Edit tasks"}
          </Button>
        </div>}
      </header>
      <ArtifactSection title={`Tasks (${parsed.value.tasks.length})`} testId="or-tasks-list">
        {parsed.value.tasks.length === 0
          ? <p className="text-sm text-[var(--text-muted)]">No tasks listed.</p>
          : <ol className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
            {parsed.value.tasks.map((task, index) => <li key={`${index}-${task.id}`} className="flex flex-col gap-2 py-3">
              <TaskText anchor={`/tasks/${index}/id`} value={task.id} editor={editor} />
              <TaskText anchor={`/tasks/${index}/description`} value={task.description} editor={editor} isProse />
              <RequirementLinks task={task} anchor={`/tasks/${index}`} editor={editor} />
            </li>)}
          </ol>}
      </ArtifactSection>
    </article>
  );
}
