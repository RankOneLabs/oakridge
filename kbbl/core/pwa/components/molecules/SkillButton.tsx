import type { Skill } from "../../../runtime-interface";

export type SkillButtonState = "idle" | "disabled" | "collecting" | "dispatching";

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
      aria-pressed={state === "collecting"}
    >
      <span className="skill-btn__name">{skill.name}</span>
      <span className="skill-btn__badge">{skill.backend}</span>
      {skill.args.length > 0 && (
        <span className="skill-btn__arg-affordance" aria-label="requires input">⋯</span>
      )}
      {/* cohort-6: confirm gate — second-tap behavior wired here */}
      {skill.confirm === true && (
        <span className="skill-btn__confirm-affordance" aria-hidden="true" />
      )}
      {state === "dispatching" && (
        <span className="skill-btn__spinner" aria-label="dispatching" />
      )}
    </button>
  );
}
