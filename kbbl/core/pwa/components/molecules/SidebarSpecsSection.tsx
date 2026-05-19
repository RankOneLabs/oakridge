import type { SidebarSpec } from "../../sidebar/Sidebar";

export interface SidebarSpecsSectionProps {
  specs: SidebarSpec[];
  onAddSpec: () => void;
}

export function SidebarSpecsSection({ specs, onAddSpec }: SidebarSpecsSectionProps) {
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
          {specs.map((s) => (
            <li key={s.id}>
              {s.plan_id ? (
                <button
                  type="button"
                  className="sidebar-leaf sidebar-leaf-button"
                  title={`${s.title}\nstatus: ${s.status}\n→ open plan`}
                  onClick={() => {
                    window.location.hash = `plan/${s.plan_id}`;
                  }}
                >
                  <span className="sidebar-leaf-label">{s.title}</span>
                  <span className="sidebar-leaf-status">{s.status}</span>
                </button>
              ) : (
                <div
                  className="sidebar-leaf sidebar-leaf-static"
                  title={`${s.title}\nstatus: ${s.status}`}
                >
                  <span className="sidebar-leaf-label">{s.title}</span>
                  <span className="sidebar-leaf-status">{s.status}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
