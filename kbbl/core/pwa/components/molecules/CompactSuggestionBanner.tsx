export function CompactSuggestionBanner({
  sid,
  tokens,
  onClear,
}: {
  sid: string;
  tokens: number;
  onClear: () => void;
}) {
  return (
    <div className="compact-suggestion-banner">
      <span className="compact-suggestion-banner__text">
        Session is at {tokens.toLocaleString()} tokens — approaching the context limit.
      </span>
      <button
        type="button"
        className="compact-suggestion-banner__action"
        onClick={async () => {
          try {
            const res = await fetch(`/${encodeURIComponent(sid)}/compact`, {
              method: "POST",
            });
            if (res.ok) onClear();
          } catch {
            // keep banner visible so operator can retry
          }
        }}
      >
        Compact Now
      </button>
      <button
        type="button"
        className="compact-suggestion-banner__dismiss"
        onClick={onClear}
      >
        Dismiss
      </button>
    </div>
  );
}
