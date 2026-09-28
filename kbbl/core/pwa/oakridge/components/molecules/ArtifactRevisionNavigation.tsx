import type { ArtifactRevision } from "../../types";
import { formatRelative } from "../../../lib/time";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { selectStatusTone } from "../../lib/status-tone";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";

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
          <FeedbackMessage className="py-0!">{formatRelative(revision.created_at)}</FeedbackMessage>
        </Button>
      ))}
    </nav>
  );
}
