import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatRelative } from "../lib/time";

type EpicStatus = "pending" | "active" | "complete" | "archived";
type EpicStage = "spec" | "plan" | "build" | "review";

interface Epic {
  id: string;
  title: string;
  status: EpicStatus;
  current_stage: EpicStage;
  created_at: string;
}

interface Project {
  id: string;
  name: string;
  repo_path: string;
}

type StatusFilter = null | EpicStatus;

type StatusFilterOption = { label: string; value: StatusFilter };

const FILTERS: StatusFilterOption[] = [
  { label: "All", value: null },
  { label: "pending", value: "pending" },
  { label: "active", value: "active" },
  { label: "complete", value: "complete" },
  { label: "archived", value: "archived" },
];

interface RepoDashboardViewProps {
  project_id: string;
  onBack: () => void;
}

export function RepoDashboardView({ project_id, onBack }: RepoDashboardViewProps) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(null);

  const projectQuery = useQuery({
    queryKey: ["projects", project_id],
    queryFn: async (): Promise<Project> => {
      const res = await fetch(`/projects/${encodeURIComponent(project_id)}`);
      if (!res.ok) throw new Error(`project: ${res.status}`);
      return (await res.json()) as Project;
    },
  });

  const epicsQuery = useQuery({
    queryKey: ["epics", project_id, statusFilter],
    queryFn: async (): Promise<Epic[]> => {
      const url =
        statusFilter === null
          ? `/epics?project_id=${encodeURIComponent(project_id)}`
          : `/epics?project_id=${encodeURIComponent(project_id)}&status=${encodeURIComponent(statusFilter)}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`epics: ${res.status}`);
      return (await res.json()) as Epic[];
    },
  });

  const error =
    projectQuery.error instanceof Error
      ? projectQuery.error.message
      : epicsQuery.error instanceof Error
        ? epicsQuery.error.message
        : null;

  if (error) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div className="review-error-message">{error}</div>
      </div>
    );
  }

  if (projectQuery.isPending || !projectQuery.data) {
    return (
      <div className="review-load-shell">
        <button type="button" onClick={onBack}>Back</button>
        <div>Loading…</div>
      </div>
    );
  }

  const project = projectQuery.data;
  const epics = epicsQuery.data ?? [];
  const epicsLoading = epicsQuery.isPending;

  return (
    <div className="repo-dashboard">
      <header className="repo-dashboard__header">
        <button
          type="button"
          className="repo-dashboard__back"
          onClick={onBack}
        >
          ← Back
        </button>
        <div className="repo-dashboard__title-block">
          <h1 className="repo-dashboard__project-name">{project.name}</h1>
          <span className="repo-dashboard__repo-path">{project.repo_path}</span>
        </div>
      </header>

      <div className="repo-dashboard__body">
        <div
          className="repo-dashboard__filters"
          role="group"
          aria-label="Filter by status"
        >
          {FILTERS.map(({ label, value }) => (
            <button
              key={label}
              type="button"
              className={[
                "repo-dashboard__filter-btn",
                statusFilter === value ? "repo-dashboard__filter-btn--active" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => setStatusFilter(value)}
              aria-pressed={statusFilter === value}
            >
              {label}
            </button>
          ))}
        </div>

        {epicsLoading ? (
          <div className="repo-dashboard__loading">Loading epics…</div>
        ) : epics.length === 0 ? (
          <div className="repo-dashboard__empty">No epics match this filter.</div>
        ) : (
          <table className="repo-dashboard__table">
            <thead>
              <tr>
                <th>Title</th>
                <th>Stage</th>
                <th>Status</th>
                <th>Created</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {epics.map((epic) => (
                <tr key={epic.id}>
                  <td>{epic.title}</td>
                  <td>
                    <span
                      className={`repo-dashboard__chip repo-dashboard__stage-${epic.current_stage}`}
                    >
                      {epic.current_stage.charAt(0).toUpperCase() +
                        epic.current_stage.slice(1)}
                    </span>
                  </td>
                  <td>
                    <span
                      className={`repo-dashboard__chip repo-dashboard__status-${epic.status}`}
                    >
                      {epic.status}
                    </span>
                  </td>
                  <td>{formatRelative(epic.created_at)}</td>
                  <td>
                    <a
                      href={`#epic/${epic.id}`}
                      onClick={(e) => {
                        e.preventDefault();
                        window.location.hash = `epic/${epic.id}`;
                      }}
                    >
                      View
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
