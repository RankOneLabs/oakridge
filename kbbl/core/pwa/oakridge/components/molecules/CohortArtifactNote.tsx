import type { CohortArtifactLookup } from "../../lib/cohort-artifact";

interface Props {
  lookup: Exclude<CohortArtifactLookup<unknown>, { kind: "found" }>;
  /** What the sibling is called in prose, e.g. "build brief". */
  artifactName: string;
  testId: string;
}

function selectNoteText({ lookup, artifactName }: Pick<Props, "lookup" | "artifactName">): string {
  if (lookup.kind === "loading") return `Loading the cohort's ${artifactName}…`;
  const cohort = lookup.cohort_label ? `cohort ${lookup.cohort_label}` : "this cohort";
  return lookup.kind === "error"
    ? `Couldn't load the ${artifactName} for ${cohort}, so there is nothing to compare against. It may exist; the request failed.`
    : `No ${artifactName} for ${cohort} in this run as of this revision, so there is nothing to compare against.`;
}

/** Why a comparison against a sibling artifact is not shown. */
export function CohortArtifactNote({ lookup, artifactName, testId }: Props) {
  return (
    <p className={`text-xs ${lookup.kind === "error" ? "text-[var(--danger-fg)]" : "text-[var(--text-muted)]"}`} data-testid={testId} role={lookup.kind === "error" ? "alert" : undefined}>
      {selectNoteText({ lookup, artifactName })}
    </p>
  );
}
