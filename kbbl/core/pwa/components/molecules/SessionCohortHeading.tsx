export interface SessionCohortHeadingProps {
  title: string | null;
  unitId: string;
  repositoryKey: string | null;
}

/** Heading for one session-cohort-group section: title, cohort id, and repository key when present. */
export function SessionCohortHeading({ title, unitId, repositoryKey }: SessionCohortHeadingProps) {
  return (
    <h2 className="session-cohort-heading">
      <span className="session-cohort-heading__title">{title ?? unitId}</span>
      <span className="session-cohort-heading__id">{unitId}</span>
      {repositoryKey && (
        <span className="session-cohort-heading__repo">{repositoryKey}</span>
      )}
    </h2>
  );
}
