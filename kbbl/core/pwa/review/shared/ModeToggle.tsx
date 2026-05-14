interface Props {
  mode: "direct-edit" | "review";
  onChange: (mode: "direct-edit" | "review") => void;
}

export function ModeToggle({ mode, onChange }: Props) {
  return (
    <div className="mode-toggle">
      <button
        type="button"
        className={`mode-toggle-btn${mode === "direct-edit" ? " mode-toggle-btn--active" : ""}`}
        onClick={() => onChange("direct-edit")}
      >
        Direct edit
      </button>
      <button
        type="button"
        className={`mode-toggle-btn${mode === "review" ? " mode-toggle-btn--active" : ""}`}
        onClick={() => onChange("review")}
      >
        Review
      </button>
    </div>
  );
}
