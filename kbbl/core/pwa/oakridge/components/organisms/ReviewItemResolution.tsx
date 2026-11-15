import { TextInput } from "../../../components/atoms/TextInput";
import { useState } from "react";
import type { ReviewItem } from "../../collab-types";
import { Button } from "../../../components/atoms/Button";
interface ReviewItemResolutionProps {
  item: ReviewItem;
  onResolve: (id: string, resolution: string) => void;
  onWaive: (id: string, resolution: string) => void;
}

export function ReviewItemResolution({ item, onResolve, onWaive }: ReviewItemResolutionProps) {
  const [resolution, setResolution] = useState("");
  return (
        <div className="or-review-item__actions">
          <TextInput
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
  );
}
