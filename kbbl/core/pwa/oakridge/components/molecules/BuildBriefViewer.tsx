import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import type { ViewerProps } from "../../artifactRegistry";
import { isBuildBrief } from "../../lib/build-brief";
import { ArtifactSection, artifactLabelClass } from "./ArtifactSection";
import { EditableBriefText } from "./EditableBriefText";
import { ExpandableText } from "./ExpandableText";

type Editor = NonNullable<ViewerProps["edit"]> | null;

interface BriefTextProps {
  anchor: string;
  value: string;
  editor: Editor;
  className: string;
  isProse?: boolean;
  lineCount?: 3 | 6;
}

/** An atom read as text, or as an edit trigger while the brief is in edit mode. */
function BriefText({ anchor, value, editor, className, isProse = false, lineCount = 3 }: BriefTextProps) {
  if (editor) return <EditableBriefText anchor={anchor} value={value} edit={editor} isMultiline={isProse} />;
  return isProse ? <ExpandableText text={value} className={className} lineCount={lineCount} /> : <span className={className}>{value}</span>;
}

function EmptyNote({ children }: { children: string }) {
  return <p className="text-sm text-[var(--text-muted)]">{children}</p>;
}

interface ReasonedItemProps {
  anchor: string;
  headline: { key: string; value: string };
  reason: { key: string; label: string; value: string };
  editor: Editor;
}

/** A decision with its rationale, or a rejected approach with why it lost. */
function ReasonedItem({ anchor, headline, reason, editor }: ReasonedItemProps) {
  return (
    <li className="flex flex-col gap-1 py-2.5">
      <BriefText anchor={`${anchor}/${headline.key}`} value={headline.value} editor={editor} className="text-sm font-medium text-[var(--text-primary)]" />
      <div className={artifactLabelClass}>{reason.label}</div>
      <BriefText anchor={`${anchor}/${reason.key}`} value={reason.value} editor={editor} isProse className="text-sm text-[var(--text-secondary)]" />
    </li>
  );
}

export function BuildBriefViewer({ body, edit }: ViewerProps) {
  const [isEditing, setIsEditing] = useState(false);

  if (!isBuildBrief(body)) {
    return <div className="or-error" role="alert">This build brief does not match the registered contract.</div>;
  }
  const editor: Editor = isEditing && edit?.enabled ? edit : null;

  return (
    <article className="flex flex-col gap-5" data-testid="or-build-brief-viewer">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <code className="or-code">{body.cohort_id}</code>
          <Chip tone="neutral">{body.repository_key}</Chip>
          {body.depends_on.length > 0 && <span className={artifactLabelClass}>After</span>}
          {body.depends_on.map((id) => <Chip key={id} tone="muted" className="font-mono">{id}</Chip>)}
          {edit?.enabled && (
            <div className="ml-auto flex items-center gap-2">
              {editor?.isPending && <span className="text-xs text-[var(--text-muted)]">Saving…</span>}
              <Button variant={isEditing ? "primary" : "secondary"} size="xsmall" className="text-xs!" aria-pressed={isEditing} onClick={() => setIsEditing(!isEditing)}>
                {isEditing ? "Done editing" : "Edit brief"}
              </Button>
            </div>
          )}
        </div>
        <h2 className="m-0 text-lg font-semibold leading-snug text-[var(--text-primary)]">{body.title}</h2>
      </header>

      <ArtifactSection title="Goal" testId="or-brief-goal">
        <BriefText anchor="/goal" value={body.goal} editor={editor} isProse lineCount={6} className="text-sm leading-relaxed text-[var(--text-primary)]" />
      </ArtifactSection>

      <ArtifactSection title="Next action" testId="or-brief-next-action">
        <div className="rounded-md border-l-4 border-[var(--accent-blue)] bg-[var(--accent-muted)] px-3 py-2">
          <BriefText anchor="/next_action" value={body.next_action} editor={editor} isProse className="text-sm text-[var(--text-primary)]" />
        </div>
      </ArtifactSection>

      <ArtifactSection title={`Files in scope (${body.files_in_scope.length})`} testId="or-brief-files">
        {body.files_in_scope.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {body.files_in_scope.map((file, index) => (
              <li key={`${index}-${file}`}>
                <BriefText anchor={`/files_in_scope/${index}`} value={file} editor={editor} className="font-mono text-xs text-[var(--text-secondary)]" />
              </li>
            ))}
          </ul>
        ) : <EmptyNote>No files listed.</EmptyNote>}
      </ArtifactSection>

      <ArtifactSection title={`Decisions made (${body.decisions_made.length})`} testId="or-brief-decisions">
        {body.decisions_made.length > 0 ? (
          <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
            {body.decisions_made.map((item, index) => (
              <ReasonedItem
                key={`${index}-${item.decision}`}
                anchor={`/decisions_made/${index}`}
                headline={{ key: "decision", value: item.decision }}
                reason={{ key: "rationale", label: "Rationale", value: item.rationale }}
                editor={editor}
              />
            ))}
          </ul>
        ) : <EmptyNote>No decisions listed.</EmptyNote>}
      </ArtifactSection>

      <ArtifactSection title={`Approaches rejected (${body.approaches_rejected.length})`} testId="or-brief-rejected">
        {body.approaches_rejected.length > 0 ? (
          <ul className="m-0 list-none divide-y divide-[var(--border-subtle)] p-0">
            {body.approaches_rejected.map((item, index) => (
              <ReasonedItem
                key={`${index}-${item.approach}`}
                anchor={`/approaches_rejected/${index}`}
                headline={{ key: "approach", value: item.approach }}
                reason={{ key: "reason", label: "Why not", value: item.reason }}
                editor={editor}
              />
            ))}
          </ul>
        ) : <EmptyNote>No rejected approaches.</EmptyNote>}
      </ArtifactSection>

      <ArtifactSection title={`Acceptance criteria (${body.acceptance_criteria.length})`} testId="or-brief-acceptance">
        {body.acceptance_criteria.length > 0 ? (
          <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm text-[var(--text-secondary)]">
            {body.acceptance_criteria.map((criterion, index) => (
              <li key={`${index}-${criterion}`}>
                <BriefText anchor={`/acceptance_criteria/${index}`} value={criterion} editor={editor} className="text-sm text-[var(--text-secondary)]" />
              </li>
            ))}
          </ol>
        ) : <EmptyNote>No acceptance criteria listed.</EmptyNote>}
      </ArtifactSection>
    </article>
  );
}
