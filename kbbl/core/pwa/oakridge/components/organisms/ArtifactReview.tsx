import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { OperatorSchema, OperatorScopeView } from "../../operator-contracts";
import { selectArtifactInScopes, selectScopeDetail } from "../../lib/run-overview";
import { resolveViewer } from "../../artifactRegistry";
import { createOperatorThread } from "../../client";
import { queryKeys } from "../../queryKeys";
import { useThreads } from "../../hooks/useThreads";
import { usePingThread } from "../../hooks/usePingThread";
import { randomUuid } from "../../../lib/random-uuid";
import { Button } from "../../../components/atoms/Button";
import { ReviewItemsChecklist } from "../molecules/ReviewItemsChecklist";
import { ArtifactRevisionNavigation } from "../molecules/ArtifactRevisionNavigation";
import { ArtifactReviewShell } from "./ArtifactReviewShell";
import { GateDecisionActions } from "./GateDecisionActions";

interface Props { readonly revisionId: string; readonly scopes: readonly OperatorScopeView[]; readonly schemas: readonly OperatorSchema[];
  readonly onBack: () => void; readonly onRefresh: () => void }
export function ArtifactReview({ revisionId, scopes, schemas, onBack, onRefresh }: Props) {
  const artifact = selectArtifactInScopes(scopes, revisionId);
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [isPing, setIsPing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const client = useQueryClient();
  const threads = useThreads(artifact?.revision.run_id ?? "", artifact?.scope_id ?? "", revisionId, artifact !== null);
  const message = usePingThread(artifact?.revision.run_id ?? "", artifact?.scope_id ?? "", revisionId);
  if (!artifact) return <ArtifactReviewShell title="Artifact" onBack={onBack}><p role="status">This revision is unavailable in the current scope projection.</p></ArtifactReviewShell>;
  const Viewer = resolveViewer(artifact.revision.body.schema);
  const scope = selectScopeDetail(scopes, artifact.scope_id);
  return <ArtifactReviewShell title={artifact.output.output_key} onBack={onBack}>
    <ArtifactRevisionNavigation revision={artifact.revision} />
    <Viewer body={artifact.revision.body} schemas={schemas} />
    {scope && <GateDecisionActions scope={scope} revisionId={revisionId} schemas={schemas} onRefresh={onRefresh} />}
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
        void createOperatorThread({ run_id: artifact.revision.run_id, scope_id: artifact.scope_id, revision_id: revisionId,
          title: title.trim(), anchor: null, request_key: randomUuid() }).then(() => {
          setTitle(""); void client.invalidateQueries({ queryKey: queryKeys.threads(artifact.revision.run_id, artifact.scope_id, revisionId) });
        }).catch((cause: unknown) => setError(String(cause)));
      }}><label>New thread title<input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
        <Button type="submit">Start thread</Button></form>
      {selectedThreadId && <form onSubmit={(event) => { event.preventDefault(); if (!text.trim()) return;
        void message.mutateAsync({ run_id: artifact.revision.run_id, scope_id: artifact.scope_id, thread_id: selectedThreadId,
          request_key: randomUuid(), text: text.trim(), author: "operator", ping: isPing }).then(() => { setText(""); setSelectedThreadId(null); })
          .catch((cause: unknown) => setError(String(cause)));
      }}><label>Reply<textarea value={text} onChange={(event) => setText(event.target.value)} /></label>
        <label><input type="checkbox" checked={isPing} onChange={(event) => setIsPing(event.target.checked)} />Ping agent</label>
        <Button type="submit" disabled={message.isPending}>Send reply</Button></form>}
      {error && <p role="alert">{error}</p>}
    </section>
  </ArtifactReviewShell>;
}
