export interface SessionUnitHeadingProps {
  /** The unit's label from its run, or its id while the run is loading. */
  title: string;
}

/** Heading for the sessions one unit of a run started. */
export function SessionUnitHeading({ title }: SessionUnitHeadingProps) {
  return (
    <h2 className="session-cohort-heading">
      <span className="session-cohort-heading__title">{title}</span>
    </h2>
  );
}
