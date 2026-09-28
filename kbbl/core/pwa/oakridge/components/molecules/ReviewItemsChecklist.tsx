import { useState } from "react";
import type { ReviewItem } from "../../types";
import { Button } from "../../../components/atoms/Button";
import { Chip } from "../../../components/atoms/Chip";
import { FeedbackMessage } from "../../../components/atoms/FeedbackMessage";

interface ReviewItemRowProps {
  item: ReviewItem;
  onResolve: (id: string, resolution: string) => void;
  onWaive: (id: string, resolution: string) => void;
}

function ReviewItemRow({ item, onResolve, onWaive }: ReviewItemRowProps) {
  const [resolution, setResolution] = useState("");
  const isOpen = item.status === "open";

  return (
    <div
      className={`or-review-item or-review-item--${item.status}`}
      data-testid="or-review-item"
    >
      <div className="or-review-item__anchor">
        <code className="or-code">{item.anchor}</code>
      </div>
      <div className="or-review-item__claim">
        <span className="or-label">Claim</span>
        <span>{item.claim}</span>
      </div>
      <div className="or-review-item__reality">
        <span className="or-label">Reality</span>
        <span>{item.reality}</span>
      </div>
      {item.status !== "open" && item.resolution && (
        <div className="or-review-item__resolution">
          <span className="or-label">Resolution</span>
          <span className="or-muted">{item.resolution}</span>
        </div>
      )}
      {item.status !== "open" && (
        <Chip tone="neutral">{item.status}</Chip>
      )}
      {isOpen && (
        <div className="or-review-item__actions">
          <input
            type="text"
            aria-label="Resolution note"
            className="or-input or-review-item__resolution-input"
            placeholder="Resolution note (optional)…"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          />
          <Button
            size="small"
            variant="primary"
            onClick={() => onResolve(item.id, resolution)}
          >
            Resolve
          </Button>
          <Button
            size="small"
            variant="secondary"
            onClick={() => onWaive(item.id, resolution)}
          >
            Waive
          </Button>
        </div>
      )}
    </div>
  );
}

interface ReviewItemsChecklistProps {
  items: ReviewItem[];
  onResolve: (id: string, resolution: string) => void;
  onWaive: (id: string, resolution: string) => void;
}

export function ReviewItemsChecklist({
  items,
  onResolve,
  onWaive,
}: ReviewItemsChecklistProps) {
  const openCount = items.filter((i) => i.status === "open").length;

  return (
    <div className="or-review-items" data-testid="or-review-items">
      <div className="or-review-items__header">
        <span className="or-label">Review Items</span>
        {openCount > 0 && (
          <Chip tone="neutral">{openCount} open</Chip>
        )}
        {openCount === 0 && items.length > 0 && (
          <Chip tone="neutral">all resolved</Chip>
        )}
      </div>
      {items.length === 0 && (
        <FeedbackMessage>No review items.</FeedbackMessage>
      )}
      {items.map((item) => (
        <ReviewItemRow
          key={item.id}
          item={item}
          onResolve={onResolve}
          onWaive={onWaive}
        />
      ))}
    </div>
  );
}
