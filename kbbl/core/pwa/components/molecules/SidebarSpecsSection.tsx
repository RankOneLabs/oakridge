import type { SidebarCohort, SidebarSpec } from "../../sidebar/Sidebar";

export interface SidebarSpecsSectionProps {
  specs: SidebarSpec[];
  cohortsByPlan: Map<string, SidebarCohort[]>;
  expandedSpecs: Set<string>;
  onToggleSpec: (id: string) => void;
  onAddSpec: () => void;
}

export function SidebarSpecsSection({
  specs,
  cohortsByPlan,
  expandedSpecs,
  onToggleSpec,
  onAddSpec,
}: SidebarSpecsSectionProps) {
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-label">
        Plans / Epics
        <button
          type="button"
          className="sidebar-section-add"
          onClick={onAddSpec}
          title="Create a plan/epic (spec) for this project"
          aria-label="Create plan/epic"
        >
          +
        </button>
      </div>
      {specs.length === 0 ? (
        <div className="sidebar-section-empty">none</div>
      ) : (
        <ul className="sidebar-section-list">
          {specs.map((s) => {
            const expanded = expandedSpecs.has(s.id);
            const cohorts = s.plan_id ? cohortsByPlan.get(s.plan_id) : undefined;
            return (
              <li key={s.id}>
                {s.plan_id ? (
                  <div className="sidebar-spec-row">
                    <button
                      type="button"
                      className="sidebar-spec-chevron"
                      onClick={() => onToggleSpec(s.id)}
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? `Collapse cohorts for ${s.title}`
                          : `Expand cohorts for ${s.title}`
                      }
                    >
                      {expanded ? "▾" : "▸"}
                    </button>
                    <button
                      type="button"
                      className="sidebar-leaf sidebar-leaf-button sidebar-spec-link"
                      title={`${s.title}\nstatus: ${s.status}\n→ open plan`}
                      onClick={() => {
                        window.location.hash = `plan/${s.plan_id}`;
                      }}
                    >
                      <span className="sidebar-leaf-label">{s.title}</span>
                      <span className="sidebar-leaf-status">{s.status}</span>
                    </button>
                  </div>
                ) : (
                  <div
                    className="sidebar-leaf sidebar-leaf-static"
                    title={`${s.title}\nstatus: ${s.status}`}
                  >
                    <span className="sidebar-leaf-label">{s.title}</span>
                    <span className="sidebar-leaf-status">{s.status}</span>
                  </div>
                )}
                {s.plan_id && expanded && (
                  <ul className="sidebar-cohort-list">
                    {cohorts === undefined ? (
                      <li className="sidebar-section-empty">loading…</li>
                    ) : cohorts.length === 0 ? (
                      <li className="sidebar-section-empty">no cohorts</li>
                    ) : (
                      [...cohorts]
                        .sort((a, b) => a.position - b.position)
                        .map((c) => (
                          <li key={c.id}>
                            <button
                              type="button"
                              className="sidebar-leaf sidebar-leaf-button sidebar-cohort-row"
                              title={`${c.title}\nstatus: ${c.status}`}
                              onClick={() => {
                                window.location.hash = `cohort/${c.id}`;
                              }}
                            >
                              <span
                                className={`sidebar-cohort-dot sidebar-cohort-dot-${c.status}`}
                                aria-hidden="true"
                              />
                              <span className="sidebar-leaf-label">{c.title}</span>
                              <span className="sidebar-leaf-status">{c.status}</span>
                            </button>
                          </li>
                        ))
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
