import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { StatusBadge } from "../components/atoms/StatusBadge";
import { GateResumeForm } from "../GateResumeForm";
import { useInboxAdmission } from "../hooks/useInboxAdmission";
import { useReviewInbox } from "../hooks/useReviewInbox";
import type { CohortLifecycle, ParkedGate, ReviewInboxItem } from "../types";

interface ReviewInboxViewProps {
  onSelectRun: (id: string) => void;
  onSelectArtifact: (id: string) => void;
}

const LIFECYCLE_LABELS: Record<CohortLifecycle, string> = {
  waiting_admission: "Waiting for admission",
  building: "Building",
  artifact_review: "Artifact review",
  revision_requested: "Revision requested",
  merge_confirmation: "Merge confirmation",
  assessing: "Assessing",
  complete: "Done",
  failed: "Failed",
};

const ITEM_LABELS: Record<ReviewInboxItem["kind"], string> = {
  admission: "Build admission",
  artifact_gate: "Artifact review",
  merge_confirmation: "Merge confirmation",
  cohort_blocked: "Blocked cohort",
  cohort_failed: "Failed cohort",
  gate_decision: "Gate decision",
};

function itemPriority(item: ReviewInboxItem): number {
  if (item.state === "actionable") return 0;
  if (item.state === "blocked") return 1;
  return 2;
}

function InboxGateAction({ item }: { item: ReviewInboxItem }) {
  const [open, setOpen] = useState(false);
  if (!item.gate_id || !item.artifact_revision_id || item.resume_actions.length === 0) return null;
  const gate: ParkedGate = {
    id: item.gate_id,
    gate_type: item.kind === "merge_confirmation" ? "merge_confirmation" : "artifact_approval",
    gate_step: item.kind === "merge_confirmation" ? "merge_confirmation" : "artifact_approval",
    run_id: item.run_id,
    stage_name: item.stage_name,
    unit_id: item.unit_id,
    repository_key: item.repository_key,
    artifact_revision_id: item.artifact_revision_id,
    worktree: null,
    resume_actions: item.resume_actions,
    pr_url: item.pr_url,
  };

  return open ? (
    <div className="basis-full" data-testid="or-inbox-gate-form">
      <GateResumeForm gate={gate} onDone={() => setOpen(false)} />
    </div>
  ) : (
    <button type="button" className="rounded-md border border-[var(--accent-blue)] bg-[var(--accent-blue)] px-3 py-1.5 text-sm text-white" onClick={() => setOpen(true)} data-testid="or-inbox-advance-btn">
      Review and advance
    </button>
  );
}

export function ReviewInboxView({ onSelectRun, onSelectArtifact }: ReviewInboxViewProps) {
  const client = useQueryClient();
  const query = useReviewInbox();
  const admission = useInboxAdmission();

  if (query.isError) {
    return <div role="alert" className="rounded-md border border-red-500 p-4 text-red-500" data-testid="or-review-inbox-error">{query.error instanceof Error ? query.error.message : "Failed to load review inbox"}</div>;
  }
  if (query.isPending || !query.data) {
    return <div className="py-6 text-sm text-[var(--text-muted)]" data-testid="or-review-inbox-loading">Loading review inbox…</div>;
  }

  const items = query.data.items
    .filter((item) => item.state !== "completed")
    .sort((a, b) => itemPriority(a) - itemPriority(b));
  const activeCohorts = query.data.cohorts.filter((cohort) => cohort.lifecycle !== "complete");

  return (
    <div className="flex flex-col gap-7" data-testid="or-review-inbox">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-lg font-semibold text-[var(--text-primary)]">Review inbox</h2>
          <p className="mb-0 mt-1 text-sm text-[var(--text-muted)]">Admissions, reviews, blockers, and completion across active cohorts.</p>
        </div>
        <button type="button" className="rounded-md border border-[var(--border-muted)] px-3 py-1.5 text-sm text-[var(--text-secondary)]" onClick={() => void client.invalidateQueries({ queryKey: ["oakridge", "review-inbox"] })}>Refresh</button>
      </header>

      <section aria-labelledby="review-inbox-actions">
        <h3 id="review-inbox-actions" className="mb-3 mt-0 text-sm font-semibold text-[var(--text-secondary)]">Needs attention ({items.length})</h3>
        {items.length === 0 ? <div className="rounded-lg border border-[var(--border-subtle)] p-5 text-sm text-[var(--text-muted)]" data-testid="or-review-inbox-empty">Nothing needs review.</div> : (
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {items.map((item) => {
              const isAdmitting = admission.isPending && admission.variables?.stageId === item.stage_instance_id && admission.variables.unitId === item.unit_id;
              const artifactId = item.artifact_revision_id;
              return <article key={item.id} className="flex min-w-0 flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)] p-4" data-testid="or-review-inbox-item">
                <div className="flex flex-wrap items-center gap-2">
                  <strong className="text-sm text-[var(--text-primary)]">{item.title || item.unit_id}</strong>
                  <StatusBadge status={item.lifecycle} />
                  <span className="text-xs text-[var(--text-muted)]">{ITEM_LABELS[item.kind]}</span>
                </div>
                <div className="text-sm text-[var(--text-secondary)]">{item.workflow_name} · {item.stage_name}{item.repository_key ? ` · ${item.repository_key}` : ""}</div>
                {item.blocked_by.length > 0 && <div className="text-sm text-amber-500" data-testid="or-review-inbox-blocked">Blocked by: {item.blocked_by.join(", ")}</div>}
                <div className="flex flex-wrap gap-2">
                  {item.kind === "admission" && item.state === "actionable" && <button type="button" className="rounded-md border border-[var(--accent-blue)] px-3 py-1.5 text-sm text-[var(--accent-blue)] disabled:opacity-50" disabled={isAdmitting} onClick={() => admission.mutate({ stageId: item.stage_instance_id, unitId: item.unit_id })} data-testid="or-inbox-admit-btn">{isAdmitting ? "Admitting…" : "Admit build"}</button>}
                  {item.state === "actionable" && <InboxGateAction item={item} />}
                  {artifactId && <button type="button" className="rounded-md border border-[var(--accent-blue)] px-3 py-1.5 text-sm text-[var(--accent-blue)]" onClick={() => onSelectArtifact(artifactId)} data-testid="or-inbox-artifact-link">Review artifact</button>}
                  <button type="button" className="rounded-md border border-[var(--border-muted)] px-3 py-1.5 text-sm text-[var(--text-secondary)]" onClick={() => onSelectRun(item.run_id)} data-testid="or-inbox-run-link">Open run</button>
                  {item.pr_url && <a className="rounded-md border border-[var(--border-muted)] px-3 py-1.5 text-sm text-[var(--text-secondary)]" href={item.pr_url} target="_blank" rel="noopener noreferrer">Open PR</a>}
                </div>
                {admission.isError && admission.variables?.stageId === item.stage_instance_id && admission.variables.unitId === item.unit_id && <div role="alert" className="text-sm text-red-500">{admission.error instanceof Error ? admission.error.message : "Admission failed"}</div>}
              </article>;
            })}
          </div>
        )}
      </section>

      <section aria-labelledby="cohort-progress">
        <h3 id="cohort-progress" className="mb-3 mt-0 text-sm font-semibold text-[var(--text-secondary)]">Cohort lifecycle ({query.data.cohorts.length} total · {activeCohorts.length} active)</h3>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {query.data.cohorts.map((cohort) => {
            const artifactId = cohort.artifact_revision_id;
            return <article key={cohort.id} className="flex min-w-0 flex-col gap-2 rounded-lg border border-[var(--border-subtle)] p-4" data-testid="or-cohort-lifecycle-card">
            <div className="flex flex-wrap items-center justify-between gap-2"><strong className="truncate text-sm text-[var(--text-primary)]" title={cohort.title ?? cohort.unit_id}>{cohort.title || cohort.unit_id}</strong><StatusBadge status={cohort.lifecycle} /></div>
            <div className="text-sm text-[var(--text-secondary)]">{LIFECYCLE_LABELS[cohort.lifecycle]}</div>
            <div className="text-xs text-[var(--text-muted)]">Build {cohort.completion.build_complete ? "complete" : "pending"} · Assessment {cohort.completion.assessment_complete ? "complete" : "pending"}</div>
            {cohort.admission.blocked_by.length > 0 && <div className="text-xs text-amber-500">Waiting on {cohort.admission.blocked_by.join(", ")}</div>}
            <div className="mt-1 flex flex-wrap gap-2"><button type="button" className="text-sm text-[var(--accent-blue)] underline" onClick={() => onSelectRun(cohort.run_id)}>Open run</button>{artifactId && <button type="button" className="text-sm text-[var(--accent-blue)] underline" onClick={() => onSelectArtifact(artifactId)}>Open artifact</button>}</div>
          </article>;
          })}
        </div>
      </section>
    </div>
  );
}
