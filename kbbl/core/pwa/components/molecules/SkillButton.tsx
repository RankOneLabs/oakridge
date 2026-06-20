import type { Skill } from "../../../runtime-interface";

export type SkillButtonState = "idle" | "disabled" | "collecting" | "confirming" | "dispatching";

export function SkillButton({
  skill,
  state,
  onTap,
}: {
  skill: Skill;
  state: SkillButtonState;
  onTap: () => void;
}) {
  return (
    <button
      type="button"
      className={`skill-btn skill-btn--${state}`}
      onClick={onTap}
      disabled={state === "disabled" || state === "dispatching"}
      aria-pressed={state === "collecting" || state === "confirming"}
    >
      <span className="skill-btn__name">{skill.name}</span>
      <span className="skill-btn__badge">{skill.backend}</span>
      {skill.args.length > 0 && (
        <span className="skill-btn__arg-affordance" aria-label="requires input">⋯</span>
      )}
      {state === "confirming" ? (
        <span className="skill-btn__confirm-affordance skill-btn__confirm-affordance--active" aria-label="tap to confirm">Confirm?</span>
      ) : skill.confirm === true ? (
        <span className="skill-btn__confirm-affordance" aria-hidden="true" />
      ) : null}
      {state === "dispatching" && (
        <span className="skill-btn__spinner" aria-label="dispatching" />
      )}
    </button>
  );
}
