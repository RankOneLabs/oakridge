import type { ReactNode } from "react";
import type { ArtifactReviewDescriptor } from "../../types";

interface ArtifactReviewShellProps {
  descriptor: ArtifactReviewDescriptor | null;
  header: ReactNode;
  revisionNavigation?: ReactNode;
  artifact: ReactNode;
  reviewItems?: ReactNode;
  threads?: ReactNode;
  gateActions?: ReactNode;
}

/** Shared, descriptor-driven chrome for every Oakridge review artifact. */
export function ArtifactReviewShell({
  descriptor,
  header,
  revisionNavigation,
  artifact,
  reviewItems,
  threads,
  gateActions,
}: ArtifactReviewShellProps) {
  const slots: Record<string, ReactNode> = {
    artifact,
    review_items: reviewItems,
    threads,
    gate_actions: gateActions,
  };
  const orderedKeys = ["artifact", "review_items", "threads", "gate_actions"];

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
