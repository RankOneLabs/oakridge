import type { SidebarSession } from "../../sidebar/Sidebar";

export interface SidebarSessionsSectionProps {
  sessions: SidebarSession[];
  onSelect: (sid: string) => void;
}

export function SidebarSessionsSection({ sessions, onSelect }: SidebarSessionsSectionProps) {
  return (
    <div className="sidebar-section">
      <div className="sidebar-section-label">Sessions</div>
      {sessions.length === 0 ? (
        <div className="sidebar-section-empty">none</div>
      ) : (
        <ul className="sidebar-section-list">
          {sessions.map((s) => (
            <li key={s.sid}>
              <button
                type="button"
                className="sidebar-leaf"
                onClick={() => onSelect(s.sid)}
                title={`${s.workdir}\n${s.sid}`}
              >
                <span className={`sidebar-leaf-dot sidebar-leaf-dot-${s.status}`} />
                <span className="sidebar-leaf-label">
                  {s.name || s.sid.slice(0, 8)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
