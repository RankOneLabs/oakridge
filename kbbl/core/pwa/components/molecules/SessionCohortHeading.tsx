export interface SessionCohortHeadingProps {
  title: string | null;
  secondaryId?: string;
  repositoryKey: string | null;
}

/** Heading for one run subgroup: title, optional secondary id, and repository. */
export function SessionCohortHeading({ title, secondaryId, repositoryKey }: SessionCohortHeadingProps) {
  const displayTitle = title ?? secondaryId;
  if (displayTitle === undefined) return null;
  return (
    <h2 className="session-cohort-heading">
      <span className="session-cohort-heading__title">{displayTitle}</span>
      {secondaryId !== undefined && displayTitle !== secondaryId && (
        <span className="session-cohort-heading__id">{secondaryId}</span>
      )}
      {repositoryKey && (
        <span className="session-cohort-heading__repo">{repositoryKey}</span>
      )}
    </h2>
  );
}
