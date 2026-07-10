import { useState } from "react";
import type { ReviewItem } from "./types";

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
        <span className={`or-chip or-chip--${item.status}`}>{item.status}</span>
      )}
      {isOpen && (
        <div className="or-review-item__actions">
          <input
            type="text"
            className="or-input or-review-item__resolution-input"
            placeholder="Resolution note (optional)…"
            value={resolution}
            onChange={(e) => setResolution(e.target.value)}
          />
          <button
            type="button"
            className="or-btn or-btn--sm or-btn--primary"
            onClick={() => onResolve(item.id, resolution)}
          >
            Resolve
          </button>
          <button
            type="button"
            className="or-btn or-btn--sm or-btn--secondary"
            onClick={() => onWaive(item.id, resolution)}
          >
            Waive
          </button>
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
          <span className="or-chip or-chip--open">{openCount} open</span>
        )}
        {openCount === 0 && items.length > 0 && (
          <span className="or-chip or-chip--resolved">all resolved</span>
        )}
      </div>
      {items.length === 0 && (
        <div className="or-empty">No review items.</div>
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
