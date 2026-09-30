import type { ReactNode } from "react";
import type { ArtifactReviewDescriptor } from "../../types";

interface ArtifactReviewShellProps {
  descriptor: ArtifactReviewDescriptor | null;
  header: ReactNode;
  revisionNavigation?: ReactNode;
  artifact: ReactNode;
  threads?: ReactNode;
  gateActions?: ReactNode;
}

/** Shared, descriptor-driven chrome for every Oakridge review artifact. */
export function ArtifactReviewShell({
  descriptor,
  header,
  revisionNavigation,
  artifact,
  threads,
  gateActions,
}: ArtifactReviewShellProps) {
  const slots: Record<string, ReactNode> = {
    artifact,
    threads,
    gate_actions: gateActions,
  };
  const orderedKeys = ["artifact", "threads", "gate_actions"];

  return (
    <div
      className={`or-artifact-detail or-artifact-detail--${descriptor?.layout ?? "document"}`}
      data-testid="or-artifact-detail"
      data-review-layout={descriptor?.layout ?? "document"}
    >
      {header}
      {revisionNavigation}
      {orderedKeys.map((key) => slots[key] ? (
        <div key={key} data-review-section={key}>{slots[key]}</div>
      ) : null)}
    </div>
  );
}
