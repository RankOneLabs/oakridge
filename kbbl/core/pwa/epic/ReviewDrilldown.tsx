import { useQuery } from "@tanstack/react-query";
import Markdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";

import { responseError } from "../lib/http";
import type { Assessment, DeviationsCatalogEntry } from "../../types/task-tracker";

interface ReviewDrilldownProps {
  plan_id: string | null;
  assessment_present: boolean;
}

export function ReviewDrilldown({ plan_id, assessment_present }: ReviewDrilldownProps) {
  const assessmentQuery = useQuery({
    queryKey: ["assessment", plan_id],
    queryFn: async (): Promise<unknown> => {
      const res = await fetch(`/plans/${encodeURIComponent(plan_id!)}/assessment`);
      if (!res.ok) throw await responseError(res, "assessment");
      return res.json();
    },
    enabled: assessment_present && plan_id !== null,
  });

  return (
    <div className="review-drilldown">
      <h2 className="review-drilldown__heading">Assessment</h2>
      {!assessment_present || !plan_id ? (
        <div className="review-drilldown__pending">Assessment pending.</div>
      ) : assessmentQuery.isPending ? (
        <div className="review-drilldown__loading">Loading assessment…</div>
      ) : assessmentQuery.error instanceof Error ? (
        <div className="review-drilldown__error" role="alert">
          {assessmentQuery.error.message}
        </div>
      ) : isAssessment(assessmentQuery.data) ? (
        <AssessmentView assessment={assessmentQuery.data} />
      ) : (
        // Unexpected shape — never lose data; fall back to the raw dump.
        <pre className="review-drilldown__json">
          {JSON.stringify(assessmentQuery.data, null, 2)}
        </pre>
      )}
    </div>
  );
}

function AssessmentView({ assessment }: { assessment: Assessment }) {
  return (
    <div className="review-drilldown__body">
      <div className="review-drilldown__meta">
        {assessment.model && <span>Model: {assessment.model}</span>}
        <span>{formatTimestamp(assessment.created_at)}</span>
      </div>

      <ProseSection title="Summary" markdown={assessment.summary} />

      <section className="review-drilldown__section">
        <h3 className="review-drilldown__section-title">Deviations</h3>
        {assessment.deviations_catalog.length === 0 ? (
          <div className="review-drilldown__empty">No deviations recorded.</div>
        ) : (
          assessment.deviations_catalog.map((cohort) => (
            <CohortDeviations key={cohort.cohort_id} cohort={cohort} />
          ))
        )}
      </section>

      <ProseSection title="Gap analysis" markdown={assessment.gap_analysis} />
      <ProseSection title="Fix plan" markdown={assessment.fix_plan} />
    </div>
  );
}

function ProseSection({ title, markdown }: { title: string; markdown: string }) {
  return (
    <section className="review-drilldown__section">
      <h3 className="review-drilldown__section-title">{title}</h3>
      <div className="review-drilldown__markdown">
        <Markdown rehypePlugins={[rehypeSanitize]}>{markdown}</Markdown>
      </div>
    </section>
  );
}

function CohortDeviations({ cohort }: { cohort: DeviationsCatalogEntry }) {
  return (
    <div className="review-drilldown__cohort">
      <h4 className="review-drilldown__cohort-title">{cohort.cohort_title}</h4>
      {cohort.deviations.length === 0 ? (
        <div className="review-drilldown__empty">No deviations in this cohort.</div>
      ) : (
        cohort.deviations.map((dev, idx) => (
          <div key={idx} className="review-drilldown__deviation">
            <DeviationField label="From" value={dev.from} />
            <DeviationField label="Actual" value={dev.actual} />
            <DeviationField label="Downstream impact" value={dev.downstream_impact} />
          </div>
        ))
      )}
    </div>
  );
}

function DeviationField({ label, value }: { label: string; value: string }) {
  return (
    <div className="review-drilldown__deviation-field">
      <span className="review-drilldown__deviation-label">{label}</span>
      <span className="review-drilldown__deviation-value">{value}</span>
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function isAssessment(data: unknown): data is Assessment {
  if (typeof data !== "object" || data === null) return false;
  const a = data as Record<string, unknown>;
  return (
    typeof a.summary === "string" &&
    typeof a.gap_analysis === "string" &&
    typeof a.fix_plan === "string" &&
    Array.isArray(a.deviations_catalog)
  );
}
