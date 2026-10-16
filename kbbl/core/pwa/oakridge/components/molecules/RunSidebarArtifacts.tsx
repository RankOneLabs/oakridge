import { Button } from "../../../components/atoms/Button";
import type { ArtifactId } from "../../../lib/ids";
import type { RunWorkspaceSlot } from "../../lib/run-workspace";
import type { RunArtifactRef } from "../../lib/run-overview";
import { RUN_ARTIFACT_FILTERS, type RunArtifactFilter } from "../../lib/artifact-filter";

interface RunSidebarArtifactsProps {
  rows: readonly RunArtifactRef[];
  totalCount: number;
  filter: RunArtifactFilter;
  onFilterChange: (filter: RunArtifactFilter) => void;
  /** Artifacts currently on screen in either slot, so the list can mark them. */
  openArtifactIds: ReadonlySet<string>;
  onOpen: (artifactId: ArtifactId, slot: RunWorkspaceSlot) => void;
}

/**
 * Every artifact the run holds, from `run.stages[].artifacts` — no per-artifact
 * fetch is added. Clicking a row changes the pane rather than navigating away,
 * which is the whole point of the workspace.
 */
export function RunSidebarArtifacts({ rows, totalCount, filter, onFilterChange, openArtifactIds, onOpen }: RunSidebarArtifactsProps) {
  return (
    <section className="or-run-sidebar__section" data-testid="or-sidebar-artifacts">
      <h3 className="or-run-sidebar__heading">Artifacts</h3>
      <select aria-label="Filter artifacts" data-testid="or-sidebar-artifact-filter" value={filter}
        onChange={(event) => onFilterChange(RUN_ARTIFACT_FILTERS.find(({ key }) => key === event.target.value)?.key ?? "all")}
        className="w-full rounded-md border border-[var(--border-muted)] bg-[var(--bg-surface)] px-2 py-1 text-xs text-[var(--text-primary)] focus:border-[var(--accent-blue)] focus:outline-none">
        {RUN_ARTIFACT_FILTERS.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
      </select>
      {totalCount === 0 && (
        <p className="or-run-sidebar__empty" data-testid="or-sidebar-artifacts-empty">
          No artifacts released yet.
        </p>
      )}
      {totalCount > 0 && rows.length === 0 && <p className="or-run-sidebar__empty">No artifacts in this group.</p>}
      <ul className="or-run-sidebar__list">
        {rows.map((row) => (
          <li key={row.artifact_id} className="or-run-sidebar__row">
            <Button variant="sidebar-row"
              type="button"
              className={openArtifactIds.has(row.artifact_id) ? "border-[var(--or-run-accent,var(--accent-blue))]! bg-[var(--bg-elevated)]!" : ""}
              onClick={() => onOpen(row.artifact_id, "primary")}
              data-testid="or-sidebar-artifact"
              data-artifact-id={row.artifact_id}
            >
              <span className="or-run-sidebar__row-title">
                {row.type_id}
                <span className="or-run-sidebar__row-unit">v{row.version}</span>
              </span>
              <span className="or-run-sidebar__row-meta">
                <span>{row.stage_name}</span>
                {row.label !== null && <span>{row.label}</span>}
              </span>
            </Button>
            <Button variant="secondary"
              type="button"
              className="or-run-sidebar__row-twin"
              onClick={() => onOpen(row.artifact_id, "secondary")}
              aria-label={`Open ${row.type_id} v${row.version} in the second pane`}
              data-testid="or-sidebar-artifact-twin"
            >
              ⧉
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
