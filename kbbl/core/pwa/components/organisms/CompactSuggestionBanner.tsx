export function CompactSuggestionBanner({
  tokens,
  isPending,
  error,
  onCompact,
  onDismiss,
}: {
  tokens: number;
  isPending: boolean;
  error: string | null;
  onCompact: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="compact-suggestion-banner">
      <span className="compact-suggestion-banner__text">
        Session is at {tokens.toLocaleString()} tokens — approaching the context limit.
        {error !== null && ` Compact failed: ${error}`}
      </span>
      <button
        type="button"
        className="compact-suggestion-banner__action"
        disabled={isPending}
        onClick={onCompact}
      >
        {isPending ? "Compacting…" : "Compact Now"}
      </button>
      <button
        type="button"
        className="compact-suggestion-banner__dismiss"
        onClick={onDismiss}
      >
        Dismiss
      </button>
    </div>
  );
}
