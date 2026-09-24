import type { ArtifactId } from "../../../lib/ids";
import type { RunWorkspaceSlot } from "../../lib/run-workspace";
import type { RunArtifactRef } from "../../lib/run-overview";

interface RunSidebarArtifactsProps {
  rows: readonly RunArtifactRef[];
  /** Artifacts currently on screen in either slot, so the list can mark them. */
  openArtifactIds: ReadonlySet<string>;
  onOpen: (artifactId: ArtifactId, slot: RunWorkspaceSlot) => void;
}

/**
 * Every artifact the run holds, from `run.stages[].artifacts` — no per-artifact
 * fetch is added. Clicking a row changes the pane rather than navigating away,
 * which is the whole point of the workspace.
 */
export function RunSidebarArtifacts({ rows, openArtifactIds, onOpen }: RunSidebarArtifactsProps) {
  return (
    <section className="or-run-sidebar__section" data-testid="or-sidebar-artifacts">
      <h3 className="or-run-sidebar__heading">Artifacts</h3>
      {rows.length === 0 && (
        <p className="or-run-sidebar__empty" data-testid="or-sidebar-artifacts-empty">
          No artifacts released yet.
        </p>
      )}
      <ul className="or-run-sidebar__list">
        {rows.map((row) => (
          <li key={row.artifact_id} className="or-run-sidebar__row">
            <button
              type="button"
              className={`or-run-sidebar__row-open ${openArtifactIds.has(row.artifact_id) ? "or-run-sidebar__row-open--active" : ""}`}
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
            </button>
            <button
              type="button"
              className="or-run-sidebar__row-twin"
              onClick={() => onOpen(row.artifact_id, "secondary")}
              aria-label={`Open ${row.type_id} v${row.version} in the second pane`}
              data-testid="or-sidebar-artifact-twin"
            >
              ⧉
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
