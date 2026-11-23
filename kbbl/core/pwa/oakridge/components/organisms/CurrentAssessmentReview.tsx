import { useQuery } from "@tanstack/react-query";
import type { ViewerProps } from "../../artifactRegistry";
import { readAssessmentStatus } from "../../client-assessment";
import { invalidateCachedRunUnits } from "../../client-units";
import { AssessmentDecisionBar } from "./AssessmentDecisionBar";
import { StructuredValue } from "../molecules/StructuredValue";

export function CurrentAssessmentReview({ body, source, assessment, gate }: ViewerProps) {
  const address = source && assessment ? { run: source.run_id, unit: assessment.unitId, artifact: assessment.artifact } : null;
  const status = useQuery({
    queryKey: ["oakridge", "assessment", address],
    queryFn: () => readAssessmentStatus(address!),
    enabled: address !== null,
  });
  return <section data-testid="or-assessment-viewer">
    <h3>Assessment</h3>
    <StructuredValue value={body} />
    {status.isError && <p role="alert">{status.error.message}</p>}
    {status.data && gate && address && assessment && <AssessmentDecisionBar key={status.data.assessment_revision} address={address} status={status.data}
      gate={gate} assessed={assessment.subject} workers={assessment.workers} paths={assessment.paths} body={body}
      onRecorded={() => { invalidateCachedRunUnits(address.run); void status.refetch(); }} />}
  </section>;
}
