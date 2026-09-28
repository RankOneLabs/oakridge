import type { ArtifactRevision } from "../../types";
import { formatRelative } from "../../../lib/time";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone } from "../../lib/status-tone";

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
        <Button
          key={revision.id}
          size="small"
          variant={index === selectedIndex ? "primary" : "secondary"}
          onClick={() => onSelect(index)}
          data-testid={`or-rev-tab-${index}`}
        >
          <Chip tone={selectStatusTone(revision.status)}>{revision.status}</Chip>
          <span className="text-sm text-[var(--text-muted)]">{formatRelative(revision.created_at)}</span>
        </Button>
      ))}
    </nav>
  );
}
