import { formatElapsedSeconds } from "../../lib/time";

export function ThinkingIndicator({
  elapsedSec,
  outputTokens,
}: {
  elapsedSec: number | null;
  outputTokens: number | null;
}) {
  const showElapsed = elapsedSec !== null && elapsedSec > 0;
  const showTokens = outputTokens !== null && outputTokens > 0;
  // Only the static "thinking" label sits in the live region — the elapsed
  // counter ticks every second and a polite re-announcement of "thinking ·
  // 47s · 1283 tok" each second is wildly noisy on a screen reader. The
  // outer container drops role=status; an inner span owns the announcement
  // with a stable accessible name and the meta is aria-hidden.
  return (
    <div className="row row-system">
      <div className="thinking-indicator">
        <span className="thinking-dot" aria-hidden="true" />
        <span className="thinking-dot" aria-hidden="true" />
        <span className="thinking-dot" aria-hidden="true" />
        <span
          className="thinking-label"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          thinking
        </span>
        {(showElapsed || showTokens) && (
          <span className="thinking-meta" aria-hidden="true">
            {showElapsed && ` · ${formatElapsedSeconds(elapsedSec!)}`}
            {showTokens && ` · ${outputTokens} tok`}
          </span>
        )}
      </div>
    </div>
  );
}
