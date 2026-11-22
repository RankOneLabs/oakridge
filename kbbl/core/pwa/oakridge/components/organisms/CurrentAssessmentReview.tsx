import { useQuery } from "@tanstack/react-query";
import type { ViewerProps } from "../../artifactRegistry";
import { readAssessmentStatus } from "../../client-assessment";
import { invalidateCachedRunUnits } from "../../client-units";
import { AssessmentDecisionBar } from "./AssessmentDecisionBar";

export function CurrentAssessmentReview({ body, source, assessment, gate }: ViewerProps) {
  const address = source && assessment ? { run: source.run_id, unit: assessment.unitId, artifact: assessment.artifact } : null;
  const status = useQuery({
    queryKey: ["oakridge", "assessment", address],
    queryFn: () => readAssessmentStatus(address!),
    enabled: address !== null,
  });
  if (!address || !assessment) return null;
  return <section data-testid="or-assessment-view">
    <h3>Assessment</h3>
    <pre className="whitespace-pre-wrap">{JSON.stringify(body, null, 2)}</pre>
    {status.isError && <p role="alert">{status.error.message}</p>}
    {status.data && gate && <AssessmentDecisionBar key={status.data.assessment_revision} address={address} status={status.data}
      gate={gate} assessed={assessment.subject} workers={assessment.workers} paths={assessment.paths} body={body}
      onRecorded={() => { invalidateCachedRunUnits(address.run); void status.refetch(); }} />}
  </section>;
}
