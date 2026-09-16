interface CompactControlProps {
  isPending: boolean;
  error: string | null;
  onCompact: () => void;
}

/** Persistent operator action for every live ACP session. */
export function CompactControl({
  isPending,
  error,
  onCompact,
}: CompactControlProps) {
  return (
    <div className="compact-control">
      {error !== null && (
        <span className="compact-control__error" role="alert">
          Compact failed: {error}
        </span>
      )}
      <button
        type="button"
        className="compact-control__action"
        disabled={isPending}
        onClick={onCompact}
      >
        {isPending ? "Compacting…" : "Compact"}
      </button>
    </div>
  );
}
