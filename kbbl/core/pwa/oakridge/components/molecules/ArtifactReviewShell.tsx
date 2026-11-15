import { Button } from "../../../components/atoms/Button";
import { useState, type ReactNode } from "react";
import type { ArtifactReviewDescriptor } from "../../artifact-types";

interface ArtifactReviewShellProps {
  descriptor: ArtifactReviewDescriptor | null;
  header: ReactNode;
  revisionNavigation?: ReactNode;
  artifact: ReactNode;
  structuredArtifact?: ReactNode;
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
  structuredArtifact,
  reviewItems,
  threads,
  gateActions,
}: ArtifactReviewShellProps) {
  const [mode, setMode] = useState<"rendered" | "structured">("rendered");
  const presentation = structuredArtifact ? <section>
    <div role="tablist" aria-label="Artifact presentation">
      {(["rendered", "structured"] as const).map((value) => <Button key={value} variant={mode === value ? "primary" : "secondary"} size="xsmall" role="tab" aria-selected={mode === value} onClick={() => setMode(value)}>{value}</Button>)}
    </div>
    <div hidden={mode !== "rendered"}>{artifact}</div>
    <div hidden={mode !== "structured"}>{structuredArtifact}</div>
  </section> : artifact;
  const slots: Record<string, ReactNode> = {
    artifact: presentation,
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
