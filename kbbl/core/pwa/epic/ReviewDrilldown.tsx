import { useQuery } from "@tanstack/react-query";

interface ReviewDrilldownProps {
  plan_id: string | null;
  assessment_present: boolean;
}

export function ReviewDrilldown({ plan_id, assessment_present }: ReviewDrilldownProps) {
  const assessmentQuery = useQuery({
    queryKey: ["assessment", plan_id],
    queryFn: async (): Promise<unknown> => {
      const res = await fetch(`/plans/${encodeURIComponent(plan_id!)}/assessment`);
      if (!res.ok) throw new Error(`assessment: ${res.status}`);
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
      ) : (
        <pre className="review-drilldown__json">
          {JSON.stringify(assessmentQuery.data, null, 2)}
        </pre>
      )}
    </div>
  );
}
