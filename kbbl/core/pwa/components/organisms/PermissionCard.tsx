import { useState } from "react";

import type { UiPermissionOption } from "../../types";
import type { PermissionResolution } from "../../lib/acp-timeline";
import { usePermissionAnswer } from "../../hooks/usePermissionAnswer";

// One ACP permission request. Renders exactly the options the agent
// supplied (§15.2) — never a synthesized allow/deny pair. The card
// retires via the stream's permission_resolved event, so a decision made
// on another device collapses this card too.
export function PermissionCard({
  sid,
  requestId,
  title,
  options,
  resolution,
  sessionClosed,
}: {
  sid: string;
  requestId: string;
  title: string;
  options: readonly UiPermissionOption[];
  resolution: PermissionResolution | null;
  sessionClosed: boolean;
}) {
  const answer = usePermissionAnswer(sid);
  const [error, setError] = useState<string | null>(null);

  if (resolution !== null) {
    const chosen =
      resolution.outcome === "selected"
        ? (options.find((option) => option.optionId === resolution.optionId)
            ?.name ?? resolution.optionId)
        : "cancelled";
    return (
      <div className="row row-system">
        <div
          className={`notice ${resolution.outcome === "selected" ? "notice-allow" : "notice-muted"}`}
        >
          {chosen} · {title}
        </div>
      </div>
    );
  }

  if (sessionClosed) {
    return (
      <div className="row row-system">
        <div className="notice notice-muted">unanswered · {title} (session closed)</div>
      </div>
    );
  }

  async function choose(optionId: string) {
    if (answer.isPending) return;
    setError(null);
    try {
      await answer.mutateAsync({ requestId, optionId });
    } catch (err) {
      setError(err instanceof Error ? err.message : "network error");
    }
  }

  return (
    <div className="card card-permission">
      <div className="card-permission-header">{title}</div>
      {error && <div className="card-error">error: {error}</div>}
      <div className="card-permission-buttons">
        {options.map((option) => (
          <button
            key={option.optionId}
            type="button"
            className={
              option.kind?.startsWith("reject") === true
                ? "btn-deny"
                : "btn-approve"
            }
            disabled={answer.isPending}
            onClick={() => void choose(option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}
