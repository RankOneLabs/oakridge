import { useEffect, useState } from "react";

import type { Theme } from "../../types";
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
  current_session_status?: string | null;
}

interface LoadedCohort {
  id: string;
  cohort: CohortDetail;
  briefs: Brief[];
}

export function CohortReviewView({ id, onToggleTheme, onBack }: CohortReviewViewProps) {
  // Single bundle so render can gate strictly on `loaded.id === id`. Holding
  // cohort/briefs in separate states + a `loadedId` would still allow torn
  // intermediate renders if React batches the setters differently from what
  // we expect.
  const [loaded, setLoaded] = useState<LoadedCohort | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    void (async () => {
      try {
        const cohortRes = await fetch(`/cohorts/${encodeURIComponent(id)}`);
        if (!cohortRes.ok) throw new Error(`cohort: ${cohortRes.status}`);
        const cohortBody = (await cohortRes.json()) as CohortDetail;
        if (cancelled) return;

        const briefsRes = await fetch(`/briefs?cohort_id=${encodeURIComponent(id)}`);
        if (cancelled) return;
        if (!briefsRes.ok) {
          // Surface the failure rather than letting "No brief yet." lie.
          setError(`briefs: ${briefsRes.status}`);
          return;
        }
        const briefsBody = (await briefsRes.json()) as Brief[];
        if (cancelled) return;
        setLoaded({ id, cohort: cohortBody, briefs: briefsBody });
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "load failed");
      }
    })();
    return () => { cancelled = true; };
  }, [id]);

  // Render is gated on the loaded id matching the current route id. Anything
  // else (prior cohort, or no cohort loaded yet) renders the loading shell —
  // including the one-frame gap between hash change and the useEffect commit
  // that would otherwise leak the previous cohort's data.
  const ready = loaded?.id === id ? loaded : null;

  if (error) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div className="review-error-message">{error}</div>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div>Loading cohort…</div>
      </div>
    );
  }

  const { cohort, briefs } = ready;

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
