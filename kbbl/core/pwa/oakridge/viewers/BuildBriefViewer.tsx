import { useState } from "react";
import type { ViewerProps } from "../artifactRegistry";
import { isBuildBrief } from "../lib/build-brief";

function TextList({ values, emptyLabel, anchor, edit }: { values: string[]; emptyLabel: string; anchor: string; edit: ViewerProps["edit"] }) {
  return values.length > 0 ? (
    <ul className="brief-atom-list">
      {values.map((value, index) => (
        <li className="brief-atom-list__item" key={`${index}-${value}`}>
          <EditableBriefText anchor={`${anchor}/${index}`} value={value} edit={edit} />
        </li>
      ))}
    </ul>
  ) : <div className="brief-empty">{emptyLabel}</div>;
}

function EditableBriefText({
  anchor,
  value,
  multiline = false,
  edit,
}: {
  anchor: string;
  value: string;
  multiline?: boolean;
  edit: ViewerProps["edit"];
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!edit?.enabled) return <>{value}</>;
  if (!isEditing) {
    return (
      <button type="button" aria-label={`Edit ${anchor.slice(1).replaceAll("_", " ")}`} className="review-shell__tap-target structured-doc__edit-trigger" onClick={() => { setDraft(value); setIsEditing(true); }}>
        {value}
      </button>
    );
  }

  const commit = () => {
    if (draft !== value) edit.onEdit(anchor, value, draft);
    setIsEditing(false);
  };
  return multiline ? (
    <textarea className="structured-doc__textarea" value={draft} disabled={edit.isPending} onChange={(event) => setDraft(event.target.value)} onBlur={commit} autoFocus />
  ) : (
    <input className="structured-doc__input" value={draft} disabled={edit.isPending} onChange={(event) => setDraft(event.target.value)} onBlur={commit} autoFocus />
  );
}

export function BuildBriefViewer({ body, edit }: ViewerProps) {
  if (!isBuildBrief(body)) {
    return <div className="or-error" role="alert">This build brief does not match the registered contract.</div>;
  }

  return (
    <article className="or-viewer or-viewer--build-brief" data-testid="or-build-brief-viewer">
      <header className="or-viewer__section">
        <div className="or-artifact-detail__meta">
          <span className="or-label">Cohort</span><code className="or-code">{body.cohort_id}</code>
          <span className="or-label">Repository</span><code className="or-code">{body.repository_key}</code>
        </div>
        <h2 className="or-viewer__brief-title">{body.title}</h2>
        <p className="or-viewer__summary"><EditableBriefText anchor="/goal" value={body.goal} multiline edit={edit} /></p>
      </header>

      <section className="or-viewer__section">
        <h3 className="or-viewer__section-title">Files in scope</h3>
        <TextList values={body.files_in_scope} emptyLabel="No files listed." anchor="/files_in_scope" edit={edit} />
      </section>

      <section className="or-viewer__section">
        <h3 className="or-viewer__section-title">Decisions made</h3>
        {body.decisions_made.length > 0 ? body.decisions_made.map((item, index) => (
          <div className="brief-decision-card" key={`${index}-${item.decision}`}>
            <div className="brief-decision-card__header"><EditableBriefText anchor={`/decisions_made/${index}/decision`} value={item.decision} edit={edit} /></div>
            <div className="brief-decision-card__rationale-label">Rationale</div>
            <div className="brief-decision-card__rationale-body"><EditableBriefText anchor={`/decisions_made/${index}/rationale`} value={item.rationale} multiline edit={edit} /></div>
          </div>
        )) : <div className="brief-empty">No decisions listed.</div>}
      </section>

      <section className="or-viewer__section">
        <h3 className="or-viewer__section-title">Approaches rejected</h3>
        {body.approaches_rejected.length > 0 ? body.approaches_rejected.map((item, index) => (
          <div className="brief-approach-rejected" key={`${index}-${item.approach}`}>
            <div className="brief-approach-rejected__header"><EditableBriefText anchor={`/approaches_rejected/${index}/approach`} value={item.approach} edit={edit} /></div>
            <div className="brief-approach-rejected__reason-label">Reason</div>
            <div className="brief-approach-rejected__reason-body"><EditableBriefText anchor={`/approaches_rejected/${index}/reason`} value={item.reason} multiline edit={edit} /></div>
          </div>
        )) : <div className="brief-empty">No rejected approaches.</div>}
      </section>

      <section className="or-viewer__section">
        <h3 className="or-viewer__section-title">Acceptance criteria</h3>
        <TextList values={body.acceptance_criteria} emptyLabel="No acceptance criteria listed." anchor="/acceptance_criteria" edit={edit} />
      </section>

      <section className="or-viewer__section">
        <h3 className="or-viewer__section-title">Next action</h3>
        <div className="brief-next-action"><EditableBriefText anchor="/next_action" value={body.next_action} multiline edit={edit} /></div>
      </section>
    </article>
  );
}
