import type { ReviewMode } from "./types";

interface ModeToggleProps {
  mode: ReviewMode;
  onChange: (mode: ReviewMode) => void;
  disabled: boolean;
}

export function ModeToggle({ mode, onChange, disabled }: ModeToggleProps) {
  return (
    <div
      style={{
        display: "flex",
        borderRadius: 4,
        overflow: "hidden",
        border: "1px solid var(--border-subtle)",
      }}
    >
      {(["review", "edit"] as ReviewMode[]).map((m) => {
        const active = mode === m;
        const isDisabled = disabled && m === "edit";
        return (
          <button
            key={m}
            type="button"
            onClick={() => !isDisabled && onChange(m)}
            disabled={isDisabled}
            style={{
              padding: "4px 12px",
              fontSize: 12,
              background: active ? "var(--accent-blue)" : "transparent",
              color: active ? "#fff" : "inherit",
              border: "none",
              cursor: isDisabled ? "default" : active ? "default" : "pointer",
              fontWeight: active ? 600 : 400,
              opacity: isDisabled ? 0.5 : 1,
              textTransform: "capitalize",
            }}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}
