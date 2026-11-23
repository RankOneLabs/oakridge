import { compositeId } from "../../adapters/core";
import { useQuery } from "@tanstack/react-query";
import type { ViewerProps } from "../../artifactRegistry";
import { readAssessmentStatus } from "../../client-assessment";
import { invalidateCachedRunUnits } from "../../client-units";
import { AssessmentDecisionBar } from "./AssessmentDecisionBar";
import { StructuredValue } from "../molecules/StructuredValue";

export function CurrentAssessmentReview({ body }: ViewerProps) {
  return <section data-testid="or-assessment-viewer"><h3>Assessment</h3><StructuredValue value={body} /></section>;
}

export function AssessmentControls({ body, source, assessment, gate }: ViewerProps) {
  const address = source && assessment ? { run: source.run_id, unit: assessment.unitId, artifact: assessment.artifact } : null;
  const status = useQuery({
    queryKey: ["oakridge", "assessment", address],
    queryFn: () => readAssessmentStatus(address!),
    enabled: address !== null,
  });
  const currentId = status.data && address && compositeId({ kind: "artifact", runId: address.run,
    unitId: address.unit, name: `${address.artifact}:${status.data.assessment_revision}` });
  if (currentId && currentId !== source?.revision_id) return <p role="status">A newer assessment is available. Open the latest revision to review it.</p>;
  return <>
    {status.isError && <p role="alert">{status.error.message}</p>}
    {status.data && gate && address && assessment && <AssessmentDecisionBar key={status.data.assessment_revision} address={address} status={status.data}
      gate={gate} assessed={assessment.subject} workers={assessment.workers} paths={assessment.paths} body={body}
      onRecorded={() => { invalidateCachedRunUnits(address.run); void status.refetch(); }} />}
  </>;
}
