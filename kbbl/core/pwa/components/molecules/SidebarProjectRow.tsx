import type { SidebarProject, SidebarSession, SidebarSpec } from "../../sidebar/Sidebar";

import { SidebarSessionsSection } from "./SidebarSessionsSection";
import { SidebarSpecsSection } from "./SidebarSpecsSection";

export interface SidebarProjectRowProps {
  project: SidebarProject;
  isOpen: boolean;
  onToggle: (id: string) => void;
  sessions: SidebarSession[];
  specs: SidebarSpec[];
  onSelectSession: (sid: string) => void;
  onAddSpec: (project: SidebarProject) => void;
}

export function SidebarProjectRow({
  project,
  isOpen,
  onToggle,
  sessions,
  specs,
  onSelectSession,
  onAddSpec,
}: SidebarProjectRowProps) {
  return (
    <li className="sidebar-project">
      <button
        type="button"
        className="sidebar-project-row"
        onClick={() => onToggle(project.id)}
        title={project.repo_path}
        aria-expanded={isOpen}
        aria-controls={`sidebar-project-body-${project.id}`}
      >
        <span className="sidebar-chevron">{isOpen ? "▾" : "▸"}</span>
        <span className="sidebar-project-name">{project.name}</span>
      </button>
      {isOpen && (
        <div id={`sidebar-project-body-${project.id}`} className="sidebar-project-body">
          <SidebarSessionsSection sessions={sessions} onSelect={onSelectSession} />
          <SidebarSpecsSection specs={specs} onAddSpec={() => onAddSpec(project)} />
        </div>
      )}
    </li>
  );
}
