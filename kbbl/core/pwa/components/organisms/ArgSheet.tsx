import { useState } from "react";
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
    Object.fromEntries(skill.args.map((a) => [a.key, ""])),
  );

  const canSubmit = skill.args
    .filter((a) => a.required)
    .every((a) => args[a.key]?.trim());

  return (
    <div className="arg-sheet">
      <div className="arg-sheet__backdrop" onClick={onCancel} />
      <form
        className="arg-sheet__panel"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) onSubmit(args);
        }}
      >
        <div className="arg-sheet__header">
          <span className="arg-sheet__title">{skill.name}</span>
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
          {skill.args.map((spec) => (
            <div key={spec.key} className="arg-sheet__field">
              <label className="arg-sheet__label" htmlFor={`arg-${spec.key}`}>
                {spec.hint}
                {spec.required && (
                  <span className="arg-sheet__required">*</span>
                )}
              </label>
              <input
                id={`arg-${spec.key}`}
                type="text"
                className="arg-sheet__input"
                value={args[spec.key] ?? ""}
                placeholder={spec.hint}
                onChange={(e) =>
                  setArgs((prev) => ({ ...prev, [spec.key]: e.target.value }))
                }
              />
            </div>
          ))}
        </div>
        <button type="submit" className="arg-sheet__submit" disabled={!canSubmit}>
          Run
        </button>
      </form>
    </div>
  );
}
