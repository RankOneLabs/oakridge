interface AutomaticGradingFieldProps {
  readonly is_enabled: boolean;
  readonly onChange: (is_enabled: boolean) => void;
  readonly disabled: boolean;
}

/** The run's automatic-grading choice. Off unless the operator turns it on for this run. */
export function AutomaticGradingField({ is_enabled, onChange, disabled }: AutomaticGradingFieldProps) {
  return (
    <label className="flex items-start gap-2" data-testid="or-new-run-automatic-grading">
      <input type="checkbox" className="mt-1" checked={is_enabled} disabled={disabled}
        data-testid="or-new-run-automatic-grading-input" onChange={(event) => onChange(event.target.checked)} />
      <span className="flex flex-col gap-1">
        <span className="text-sm font-medium text-[var(--text-primary)]">Automatic grading</span>
        <span className="text-xs leading-relaxed text-[var(--text-muted)]" data-testid="or-new-run-automatic-grading-disclosure">
          When on, this run&apos;s spec and repository content are sent to the configured grading provider.
        </span>
      </span>
    </label>
  );
}
