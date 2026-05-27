import type {
  SidebarCohort,
  SidebarProject,
  SidebarSession,
  SidebarSpec,
} from "../../sidebar/Sidebar";

import { SidebarSessionsSection } from "./SidebarSessionsSection";
import { SidebarSpecsSection } from "./SidebarSpecsSection";

export interface SidebarProjectRowProps {
  project: SidebarProject;
  isOpen: boolean;
  onToggle: (id: string) => void;
  onOpenDashboard: (id: string) => void;
  sessions: SidebarSession[];
  specs: SidebarSpec[];
  cohortsByPlan: Map<string, SidebarCohort[]>;
  cohortErrorsByPlan: Map<string, string>;
  expandedSpecs: Set<string>;
  onToggleSpec: (id: string) => void;
  onRetryCohorts: (planId: string) => void | Promise<void>;
  onSelectSession: (sid: string) => void;
  onAddSpec: (project: SidebarProject) => void;
}

export function SidebarProjectRow({
  project,
  isOpen,
  onToggle,
  onOpenDashboard,
  sessions,
  specs,
  cohortsByPlan,
  cohortErrorsByPlan,
  expandedSpecs,
  onToggleSpec,
  onRetryCohorts,
  onSelectSession,
  onAddSpec,
}: SidebarProjectRowProps) {
  return (
    <li className="sidebar-project">
      <div className="sidebar-project-row-header">
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
        <button
          type="button"
          className="sidebar-project-dashboard-btn"
          onClick={() => onOpenDashboard(project.id)}
          title={`Open dashboard for ${project.name}`}
          aria-label={`Open dashboard for ${project.name}`}
        >
          ⊞
        </button>
      </div>
      {isOpen && (
        <div id={`sidebar-project-body-${project.id}`} className="sidebar-project-body">
          <SidebarSessionsSection sessions={sessions} onSelect={onSelectSession} />
          <SidebarSpecsSection
            specs={specs}
            cohortsByPlan={cohortsByPlan}
            cohortErrorsByPlan={cohortErrorsByPlan}
            expandedSpecs={expandedSpecs}
            onToggleSpec={onToggleSpec}
            onRetryCohorts={onRetryCohorts}
            onAddSpec={() => onAddSpec(project)}
          />
        </div>
      )}
    </li>
  );
}
