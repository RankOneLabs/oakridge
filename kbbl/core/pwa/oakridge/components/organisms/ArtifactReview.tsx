import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OperatorSchema, OperatorUnitView } from "../../operator-contracts";
import { selectArtifactInUnits, selectUnitDetail } from "../../lib/run-overview";
import { resolveViewer } from "../../artifactRegistry";
import { createOperatorThread } from "../../client";
import { queryKeys } from "../../queryKeys";
import { useThreads } from "../../hooks/useThreads";
import { useAddThreadMessage } from "../../hooks/useAddThreadMessage";
import { randomUuid } from "../../../lib/random-uuid";
import { Button } from "../../../components/atoms/Button";
import { ReviewItemsChecklist } from "../molecules/ReviewItemsChecklist";
import { ArtifactRevisionNavigation } from "../molecules/ArtifactRevisionNavigation";
import { ArtifactReviewShell } from "./ArtifactReviewShell";
import { ArtifactEditForm } from "./ArtifactEditForm";
import { GateDecisionActions } from "./GateDecisionActions";

interface Props { readonly revisionId: string; readonly units: readonly OperatorUnitView[]; readonly schemas: readonly OperatorSchema[];
  readonly onBack: () => void; readonly onRefresh: () => void; readonly onRevised?: (revisionId: string) => void }
export function ArtifactReview({ revisionId, units, schemas, onBack, onRefresh, onRevised }: Props) {
  const selected = selectArtifactInUnits(units, revisionId);
  const successor = units.flatMap((unit) => unit.artifacts).map((artifact) => artifact.latest_revision)
    .find((revision) => revision?.predecessor_id === revisionId);
  useEffect(() => { if (successor) onRevised?.(successor.id); }, [successor, onRevised]);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const threads = useThreads(selected?.revision.run_id ?? "", selected?.unit_id ?? "", revisionId, selected !== null);
  const message = useAddThreadMessage(selected?.revision.run_id ?? "", selected?.unit_id ?? "", revisionId);
  if (!selected) return <ArtifactReviewShell title="Artifact" onBack={onBack}><p role="status">This revision is no longer among the unit's latest revisions.</p></ArtifactReviewShell>;
  const Viewer = resolveViewer(selected.artifact.schema);
  const unit = selectUnitDetail(units, selected.unit_id);
  return <ArtifactReviewShell title={selected.artifact.artifact_key} onBack={onBack}>
    <ArtifactRevisionNavigation revision={selected.revision} />
    <Viewer body={selected.revision.body} />
    {selected.artifact.is_editable && <ArtifactEditForm key={revisionId} revision={selected.revision} onEdited={onRefresh} />}
    {unit && <GateDecisionActions unit={unit} revisionId={revisionId} schemas={schemas} onRefresh={onRefresh} />}
    <section data-testid="or-artifact-threads"><h3>Discussion</h3>
      {threads.isPending && <p role="status">Loading threads…</p>}
      {threads.isError && <p role="alert">Could not load threads: {String(threads.error)}</p>}
      {(threads.data ?? []).map((thread) => <article key={thread.id}>
        <h4>{thread.context.title}</h4>
        <ul>{thread.messages.map((entry) => <li key={entry.id}><strong>{entry.body.author}</strong>: {entry.body.text}</li>)}</ul>
        <ReviewItemsChecklist items={thread.review_items} />
        {thread.capabilities.can_write && <Button variant="secondary" onClick={() => setSelectedThreadId(thread.id)}>Reply</Button>}
      </article>)}
      <form onSubmit={(event) => { event.preventDefault(); if (!title.trim()) return;
        void createOperatorThread({ run_id: selected.revision.run_id, unit_id: selected.unit_id, revision_id: revisionId,
          title: title.trim(), anchor: null, request_key: randomUuid() }).then(() => {
          setTitle(""); void client.invalidateQueries({ queryKey: queryKeys.threads(selected.revision.run_id, selected.unit_id, revisionId) });
        }).catch((cause: unknown) => setError(String(cause)));
      }}><label>New thread title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <Button type="submit">Start thread</Button></form>
      {selectedThreadId && <form onSubmit={(event) => { event.preventDefault(); if (!text.trim()) return;
        void message.mutateAsync({ run_id: selected.revision.run_id, unit_id: selected.unit_id, thread_id: selectedThreadId,
          request_key: randomUuid(), text: text.trim() }).then(() => { setText(""); setSelectedThreadId(null); })
          .catch((cause: unknown) => setError(String(cause)));
      }}><label>Reply<textarea value={text} onChange={(event) => setText(event.target.value)} /></label>
        <Button type="submit" disabled={message.isPending}>Send reply</Button></form>}
      {error && <p role="alert">{error}</p>}
    </section>
  </ArtifactReviewShell>;
}
