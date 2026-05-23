import { useQuery } from "@tanstack/react-query";

import type { SessionStatus, Theme } from "../../types";
import { RunBuildButton } from "../shared/RunBuildButton";
import type { Cohort } from "../plan/types";
import type { Brief } from "../brief/types";

interface CohortReviewViewProps {
  id: string;
  theme: Theme;
  onToggleTheme: () => void;
  onBack: () => void;
}

interface CohortDetail extends Cohort {
  current_session_ref?: string | null;
  current_session_stage?: string | null;
  current_session_status?: SessionStatus | null;
}

export function CohortReviewView({ id, onToggleTheme, onBack }: CohortReviewViewProps) {
  const cohortQuery = useQuery({
    queryKey: ["cohorts", { id }],
    queryFn: async (): Promise<CohortDetail> => {
      const res = await fetch(`/cohorts/${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`cohort: ${res.status}`);
      return (await res.json()) as CohortDetail;
    },
  });

  const briefsQuery = useQuery({
    queryKey: ["briefs", { cohortId: id }],
    queryFn: async (): Promise<Brief[]> => {
      const res = await fetch(`/briefs?cohort_id=${encodeURIComponent(id)}`);
      if (!res.ok) throw new Error(`briefs: ${res.status}`);
      return (await res.json()) as Brief[];
    },
  });

  const error =
    cohortQuery.error instanceof Error
      ? cohortQuery.error.message
      : briefsQuery.error instanceof Error
        ? briefsQuery.error.message
        : null;
  const loading = cohortQuery.isPending || briefsQuery.isPending;

  if (error) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div className="review-error-message">{error}</div>
      </div>
    );
  }

  if (loading || !cohortQuery.data || !briefsQuery.data) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div>Loading cohort…</div>
      </div>
    );
  }

  const cohort = cohortQuery.data;
  const briefs = briefsQuery.data;

  const latestBrief = briefs.length > 0
    ? [...briefs].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    : null;

  return (
    <div className="cohort-view">
      <header className="cohort-view__header">
        <button type="button" className="cohort-view__back" onClick={onBack}>
          ← Back
        </button>
        <button
          type="button"
          className="cohort-view__plan-link"
          onClick={() => { window.location.hash = `plan/${cohort.plan_id}`; }}
          title="Open plan view"
        >
          Open plan
        </button>
        <span className="cohort-view__spacer" />
        <button
          type="button"
          className="cohort-view__theme"
          onClick={onToggleTheme}
          aria-label="Toggle theme"
        >
          ◐
        </button>
      </header>

      <div className="cohort-view__body">
        <h1 className="cohort-view__title">{cohort.title}</h1>

        <div className="cohort-view__meta">
          <span className={`cohort-view__status cohort-status-${cohort.status}`}>
            {cohort.status}
          </span>
          <span className="cohort-view__position">#{cohort.position}</span>
        </div>

        {cohort.notes && (
          <section className="cohort-view__section">
            <div className="cohort-view__section-label">Notes</div>
            <div className="cohort-view__notes">{cohort.notes}</div>
          </section>
        )}

        <section className="cohort-view__section">
          <div className="cohort-view__section-label">
            Brief{briefs.length > 1 ? `s (${briefs.length})` : ""}
          </div>
          {latestBrief ? (
            <div className="cohort-view__brief">
              <button
                type="button"
                className="cohort-view__brief-link"
                onClick={() => { window.location.hash = `brief/${latestBrief.id}`; }}
                title={latestBrief.goal}
              >
                <span className="cohort-view__brief-status">{latestBrief.status}</span>
                <span className="cohort-view__brief-goal">
                  {latestBrief.goal.length > 140
                    ? `${latestBrief.goal.slice(0, 140)}…`
                    : latestBrief.goal}
                </span>
              </button>
              {latestBrief.status === "approved" && (
                <div className="cohort-view__brief-actions">
                  <RunBuildButton briefId={latestBrief.id} cohortId={cohort.id} />
                </div>
              )}
            </div>
          ) : (
            <div className="cohort-view__brief-empty">No brief yet.</div>
          )}
        </section>
      </div>
    </div>
  );
}
