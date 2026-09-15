export interface SessionCohortHeadingProps {
  title: string | null;
  unitId: string;
  repositoryKey: string | null;
}

/** Heading for one session-cohort-group section: title, cohort id, and repository key when present. */
export function SessionCohortHeading({ title, unitId, repositoryKey }: SessionCohortHeadingProps) {
  const displayTitle = title ?? unitId;
  return (
    <h2 className="session-cohort-heading">
      <span className="session-cohort-heading__title">{displayTitle}</span>
      {displayTitle !== unitId && (
        <span className="session-cohort-heading__id">{unitId}</span>
      )}
      {repositoryKey && (
        <span className="session-cohort-heading__repo">{repositoryKey}</span>
      )}
    </h2>
  );
}
