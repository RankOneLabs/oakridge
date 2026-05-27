type CohortStatus = "waiting" | "planned" | "briefing" | "brief_review" | "building" | "done" | "blocked";

interface Cohort {
  id: string;
  title: string;
  position: number;
  status: CohortStatus;
}

interface BuildDrilldownProps {
  cohorts: Cohort[];
}

export function BuildDrilldown({ cohorts }: BuildDrilldownProps) {
  const sorted = [...cohorts].sort((a, b) => a.position - b.position);

  return (
    <div className="build-drilldown">
      <h2 className="build-drilldown__heading">Cohorts</h2>
      {sorted.length === 0 ? (
        <div className="build-drilldown__empty">No cohorts yet.</div>
      ) : (
        <ul className="build-drilldown__list">
          {sorted.map((c) => {
            const dest = `cohort/${c.id}`;
            const href = `#${dest}`;
            return (
              <li key={c.id} className="build-drilldown__item">
                <span className="build-drilldown__position">{c.position}</span>
                <a
                  href={href}
                  className="build-drilldown__title"
                  onClick={(e) => {
                    e.preventDefault();
                    window.location.hash = dest;
                  }}
                >
                  {c.title}
                </a>
                <span className={`build-drilldown__chip build-drilldown__chip--${c.status}`}>
                  {c.status}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
