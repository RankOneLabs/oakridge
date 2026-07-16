import { useEffect, useState } from "react";
import type { Skill } from "../../../runtime-interface";

export function ArgSheet({
  skill,
  onSubmit,
  onCancel,
}: {
  skill: Skill;
  onSubmit: (args: Record<string, string>) => void;
  onCancel: () => void;
}) {
  const [args, setArgs] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      skill.args.map((arg) => [arg.key, arg.kind === "boolean" ? "false" : ""]),
    ),
  );

  // Escape-to-close, matching the other modal surfaces (e.g. DirectoryPicker).
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [onCancel]);

  const canSubmit = skill.args
    .filter((a) => a.required)
    .every((a) =>
      a.kind === "boolean" ? args[a.key] !== undefined : args[a.key]?.trim(),
    );

  const titleId = `arg-sheet-title-${skill.id}`;

  return (
    <div className="arg-sheet">
      <div className="arg-sheet__backdrop" onClick={onCancel} />
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="arg-sheet__panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(args);
        }}
      >
        <div className="arg-sheet__header">
          <span id={titleId} className="arg-sheet__title">{skill.name}</span>
          <button
            type="button"
            className="arg-sheet__close"
            onClick={onCancel}
            aria-label="Cancel"
          >
            ✕
          </button>
        </div>
        <div className="arg-sheet__fields">
          {skill.args.map((spec) => {
            const isBoolean = spec.kind === "boolean";
            return (
              <div
                key={spec.key}
                className={`arg-sheet__field ${
                  isBoolean ? "arg-sheet__field--boolean" : ""
                }`}
              >
                <label className="arg-sheet__label" htmlFor={`arg-${spec.key}`}>
                  {isBoolean && (
                    <input
                      id={`arg-${spec.key}`}
                      type="checkbox"
                      className="arg-sheet__checkbox"
                      checked={args[spec.key] === "true"}
                      onChange={(e) =>
                        setArgs((prev) => ({
                          ...prev,
                          [spec.key]: String(e.target.checked),
                        }))
                      }
                    />
                  )}
                  {spec.hint}
                  {spec.required && (
                    <span className="arg-sheet__required">*</span>
                  )}
                </label>
                {!isBoolean && (
                  <input
                    id={`arg-${spec.key}`}
                    type={spec.kind === "integer" ? "number" : "text"}
                    step={spec.kind === "integer" ? 1 : undefined}
                    className="arg-sheet__input"
                    value={args[spec.key] ?? ""}
                    placeholder={spec.hint}
                    onChange={(e) =>
                      setArgs((prev) => ({ ...prev, [spec.key]: e.target.value }))
                    }
                  />
                )}
              </div>
            );
          })}
        </div>
        <button type="submit" className="arg-sheet__submit" disabled={!canSubmit}>
          Run
        </button>
      </form>
    </div>
  );
}
