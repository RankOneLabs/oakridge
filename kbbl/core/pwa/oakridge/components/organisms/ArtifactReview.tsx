import { useEffect, useState } from "react";
import { useArtifact } from "../../hooks/useArtifact";
import { useThreads } from "../../hooks/useThreads";
import { usePostThread } from "../../hooks/usePostThread";
import { usePostMessage } from "../../hooks/usePostMessage";
import { usePingThread } from "../../hooks/usePingThread";
import { useResolveThread } from "../../hooks/useResolveThread";
import { useReviewItems } from "../../hooks/useReviewItems";
import { useRunGates } from "../../hooks/useRunGates";
import { usePatchReviewItem } from "../../hooks/usePatchReviewItem";
import { resolveViewer } from "../../artifactRegistry";
import { ReviewItemsChecklist } from "../../ReviewItemsChecklist";
import type { ArtifactRevision, ArtifactReviewDescriptor } from "../../types";
import { formatRelative } from "../../../lib/time";
import { ThreadSidebar } from "../../../review/shared/ThreadSidebar";
import { ThreadView } from "../../../review/shared/ThreadView";
import type { Thread, Message } from "../../../review/shared/types";
import { GateResumeForm } from "../../GateResumeForm";
import { ArtifactReviewShell } from "./ArtifactReviewShell";

// JSON pretty-print fallback — retained from ArtifactDetailView
function stringify(value: unknown): string {
  try {
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function JsonRevisionPanel({ revision, descriptor }: { revision: ArtifactRevision; descriptor?: ArtifactReviewDescriptor | null }) {
  let bodyText: string;
  try {
    bodyText = JSON.stringify(revision.body, null, 2);
  } catch {
    bodyText = String(revision.body);
  }

  let validationText: string | null = null;
  if (revision.validation !== null && revision.validation !== undefined) {
    try {
      validationText = JSON.stringify(revision.validation, null, 2);
    } catch {
      validationText = String(revision.validation);
    }
  }

  return (
    <div className="or-revision-panel" data-testid="or-revision-panel">
      <div className="or-revision-panel__body">
        <span className="or-label">Body</span>
        {descriptor?.sections.length && revision.body && typeof revision.body === "object" && !Array.isArray(revision.body) ? (
          <div data-testid="or-descriptor-sections">
            {descriptor.sections.map((section) => {
              const value = (revision.body as Record<string, unknown>)[section];
              return value === undefined ? null : (
                <section key={section} data-artifact-section={section}>
                  <h3 className="or-viewer__section-title">{section.replaceAll("_", " ")}</h3>
                  <pre className="or-pre">{stringify(value)}</pre>
                </section>
              );
            })}
          </div>
        ) : <pre className="or-pre" data-testid="or-revision-body">{bodyText}</pre>}
      </div>
      {validationText && (
        <div className="or-revision-panel__validation">
          <span className="or-label">Validation</span>
          <pre className="or-pre" data-testid="or-revision-validation">{validationText}</pre>
        </div>
      )}
    </div>
  );
}

interface ArtifactReviewProps {
  artifactId: string;
  onBack: () => void;
}

export function ArtifactReview({ artifactId, onBack }: ArtifactReviewProps) {
  const query = useArtifact(artifactId);
  const [selectedRevIdx, setSelectedRevIdx] = useState<number | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [showGateForm, setShowGateForm] = useState(true);

  // Collab data — loaded only when the artifact has relevant capabilities
  const caps = query.data?.capabilities ?? null;
  const commentable = caps?.commentable ?? false;
  const hasReviewItems = caps?.review_items ?? false;

  const threadsQuery = useThreads(artifactId, commentable);
  const reviewItemsQuery = useReviewItems(artifactId, hasReviewItems);
  const revisions = query.data?.revisions ?? [];
  const revIdx = selectedRevIdx === null
    ? Math.max(0, revisions.length - 1)
    : Math.min(selectedRevIdx, Math.max(0, revisions.length - 1));
  const revision = revisions[revIdx] as ArtifactRevision | undefined;
  const gatesQuery = useRunGates(query.data?.run_id ?? "", Boolean(query.data?.run_id));
  const gates = Array.isArray(gatesQuery.data) ? gatesQuery.data : [];
  const artifactGate = revision
    ? gates.find((gate) => gate.artifact_revision_id === revision.id)
    : undefined;

  useEffect(() => {
    setShowGateForm(true);
  }, [artifactGate?.id]);

  useEffect(() => {
    setSelectedRevIdx(null);
  }, [artifactId]);

  const postThread = usePostThread(artifactId);
  const postMessage = usePostMessage(artifactId, selectedThreadId ?? "");
  const pingThread = usePingThread(artifactId);
  const resolveThread = useResolveThread(artifactId);
  const patchReviewItem = usePatchReviewItem(artifactId);

  if (query.isError) {
    return (
      <div className="or-artifact-detail" data-testid="or-artifact-detail">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-error" role="alert" data-testid="or-artifact-detail-error">
          {query.error instanceof Error ? query.error.message : "Failed to load artifact"}
        </div>
      </div>
    );
  }

  if (query.isPending || !query.data) {
    return (
      <div className="or-artifact-detail" data-testid="or-artifact-detail">
        <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
        <div className="or-loading">Loading artifact…</div>
      </div>
    );
  }

  const artifact = query.data;

  // Resolve viewer: component_id → type_id → JSON fallback
  const Viewer =
    resolveViewer(artifact.review?.viewer) ??
    resolveViewer(artifact.component_id) ??
    resolveViewer(artifact.type_id) ??
    null;

  // Adapt oakridge CollabThread to the v1 Thread shape that ThreadSidebar/ThreadView accept
  const collabThreads = threadsQuery.data ?? [];
  const v1Threads: Thread[] = collabThreads.map((t) => ({
    id: t.id,
    target_type: "artifact",
    target_id: t.artifact_id,
    anchor: t.anchor ?? null,
    author: null,
    status: t.status,
    created_at: t.created_at,
  }));

  const selectedThread = collabThreads.find((t) => t.id === selectedThreadId) ?? null;
  const selectedV1Thread = v1Threads.find((t) => t.id === selectedThreadId) ?? null;

  const v1Messages: Message[] = selectedThread
    ? selectedThread.messages.map((m) => ({
        id: m.id,
        thread_id: m.thread_id,
        author: m.author,
        body: m.body,
        created_at: m.created_at,
      }))
    : [];

  function handleNewThread() {
    postThread.mutate({ body: "(new thread)", author: "operator", anchor: null });
  }

  function handleSendMessage(body: string) {
    if (!selectedThreadId) return;
    postMessage.mutate({ body, author: "operator" });
  }

  function handlePing() {
    if (!selectedThreadId) return;
    pingThread.mutate(selectedThreadId);
  }

  function handleResolveThread() {
    if (!selectedThreadId) return;
    resolveThread.mutate(selectedThreadId);
    setSelectedThreadId(null);
  }

  const reviewItems = reviewItemsQuery.data ?? [];

  function handleResolveItem(id: string, resolution: string) {
    patchReviewItem.mutate({ id, req: { status: "resolved", resolution: resolution || undefined } });
  }

  function handleWaiveItem(id: string, resolution: string) {
    patchReviewItem.mutate({ id, req: { status: "waived", resolution: resolution || undefined } });
  }

  const header = <>
      <button type="button" className="or-btn or-btn--secondary" onClick={onBack}>← Back</button>
      <header className="or-artifact-detail__header">
        <h2 className="or-artifact-detail__title" data-testid="or-artifact-type">
          {artifact.type_id}
        </h2>
        <div className="or-artifact-detail__meta">
          <span className="or-label">Stage</span>
          <span data-testid="or-artifact-stage">{artifact.producing_stage}</span>
          {artifact.label && (
            <>
              <span className="or-label">Unit</span>
              <code className="or-code" data-testid="or-artifact-unit-label">{artifact.label}</code>
            </>
          )}
          <span className="or-label">Run</span>
          <span>{artifact.run_id.slice(0, 8)}</span>
          {artifact.component_id && (
            <>
              <span className="or-label">Component</span>
              <code className="or-code">{artifact.component_id}</code>
            </>
          )}
        </div>
      </header>
    </>;

  const revisionNavigation = revisions.length > 1 ? (
        <nav className="or-artifact-detail__rev-nav">
          {revisions.map((rev, i) => (
            <button
              key={rev.id}
              type="button"
              className={`or-btn or-btn--sm ${i === revIdx ? "or-btn--primary" : "or-btn--secondary"}`}
              onClick={() => setSelectedRevIdx(i)}
              data-testid={`or-rev-tab-${i}`}
            >
              <span className={`or-chip or-chip--${rev.status}`}>{rev.status}</span>
              <span className="or-muted">{formatRelative(rev.created_at)}</span>
            </button>
          ))}
        </nav>
      ) : undefined;

  const artifactContent = revision ? (
        <section className="or-artifact-detail__revision">
          <div className="or-revision-panel__meta">
            <span className="or-label">Revision</span>
            <code className="or-code">{revision.id.slice(0, 8)}</code>
            <span className={`or-chip or-chip--${revision.status}`} data-testid="or-revision-status">
              {revision.status}
            </span>
            <span className="or-muted">{formatRelative(revision.created_at)}</span>
          </div>

          {Viewer ? (
            <Viewer body={revision.body} descriptor={artifact.review} />
          ) : (
            <JsonRevisionPanel revision={revision} descriptor={artifact.review} />
          )}
        </section>
      ) : <div className="or-empty">No revisions.</div>;

      {/* ── Collab chrome: review items ─────────────────────────────────── */}
  const reviewItemsContent = hasReviewItems ? (
        <section className="or-artifact-detail__collab" data-testid="or-review-items-section">
          <ReviewItemsChecklist
            items={reviewItems}
            onResolve={handleResolveItem}
            onWaive={handleWaiveItem}
          />
        </section>
      ) : undefined;

      {/* ── Collab chrome: threads ──────────────────────────────────────── */}
  const threadsContent = commentable ? (
        <section className="or-artifact-detail__threads" data-testid="or-threads-section">
          <div className="or-threads-layout">
            <ThreadSidebar
              threads={v1Threads}
              selectedThreadId={selectedThreadId}
              onSelect={setSelectedThreadId}
              onNewThread={handleNewThread}
            />
            {selectedV1Thread && (
              <ThreadView
                thread={selectedV1Thread}
                messages={v1Messages}
                onSendMessage={handleSendMessage}
                onPing={handlePing}
                onResolve={handleResolveThread}
                frozen={false}
              />
            )}
          </div>
        </section>
      ) : undefined;

  const gateActions = artifactGate ? (
    <section className="or-artifact-detail__collab" data-testid="or-artifact-gate-actions">
      {showGateForm ? (
        <GateResumeForm
          gate={artifactGate}
          actionLabels={artifact.review?.action_labels}
          onDone={() => setShowGateForm(false)}
        />
      ) : (
        <button type="button" className="or-btn or-btn--primary" onClick={() => setShowGateForm(true)}>
          Review gate
        </button>
      )}
    </section>
  ) : undefined;

  return (
    <ArtifactReviewShell
      descriptor={artifact.review ?? null}
      header={header}
      revisionNavigation={revisionNavigation}
      artifact={artifactContent}
      reviewItems={reviewItemsContent}
      threads={threadsContent}
      gateActions={gateActions}
    />
  );
}
