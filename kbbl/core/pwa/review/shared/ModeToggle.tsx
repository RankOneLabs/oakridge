import type { ReviewMode } from "./types";

interface ModeToggleProps {
  mode: ReviewMode;
  onChange: (mode: ReviewMode) => void;
  disabled: boolean;
}

export function ModeToggle({ mode, onChange, disabled }: ModeToggleProps) {
  return (
    <div className="mode-toggle">
      {(["review", "edit"] as ReviewMode[]).map((m) => {
        const active = mode === m;
        const isDisabled = disabled && m === "edit";
        return (
          <button
            key={m}
            type="button"
            onClick={() => !isDisabled && onChange(m)}
            disabled={isDisabled}
            className={`mode-toggle__segment${active ? " mode-toggle__segment--active" : ""}`}
          >
            {m}
          </button>
        );
      })}
    </div>
  );
}
