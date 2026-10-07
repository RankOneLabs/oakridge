import type { CohortArtifactLookup } from "../../lib/cohort-artifact";

interface Props {
  lookup: Exclude<CohortArtifactLookup<unknown>, { kind: "found" }>;
  /** What the sibling is called in prose, e.g. "build brief". */
  artifactName: string;
  testId: string;
}

/** Why a comparison against a sibling artifact is not shown. */
export function CohortArtifactNote({ lookup, artifactName, testId }: Props) {
  const text = lookup.kind === "loading"
    ? `Loading the cohort's ${artifactName}…`
    : `No ${artifactName} for ${lookup.cohort_label ? `cohort ${lookup.cohort_label}` : "this cohort"} in this run, so there is nothing to compare against.`;
  return <p className="text-xs text-[var(--text-muted)]" data-testid={testId}>{text}</p>;
}
