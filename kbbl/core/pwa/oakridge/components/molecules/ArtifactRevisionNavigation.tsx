import type { ArtifactRevision } from "../../types";
import { formatRelative } from "../../../lib/time";

interface ArtifactRevisionNavigationProps {
  revisions: readonly ArtifactRevision[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}

/**
 * The revision tabs of a multi-revision artifact.
 *
 * Presentational: the caller has already resolved which index is showing, so
 * this holds no state and cannot disagree with the panel beside it.
 */
export function ArtifactRevisionNavigation({
  revisions,
  selectedIndex,
  onSelect,
}: ArtifactRevisionNavigationProps) {
  return (
    <nav className="or-artifact-detail__rev-nav">
      {revisions.map((revision, index) => (
        <button
          key={revision.id}
          type="button"
          className={`or-btn or-btn--sm ${index === selectedIndex ? "or-btn--primary" : "or-btn--secondary"}`}
          onClick={() => onSelect(index)}
          data-testid={`or-rev-tab-${index}`}
        >
          <span className={`or-chip or-chip--${revision.status}`}>{revision.status}</span>
          <span className="or-muted">{formatRelative(revision.created_at)}</span>
        </button>
      ))}
    </nav>
  );
}
