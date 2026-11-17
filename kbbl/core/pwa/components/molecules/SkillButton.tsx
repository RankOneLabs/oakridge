import { Button } from "../atoms/Button";
import type { Skill } from "../../../runtime-interface";
import { selectSkillButtonLabel, type SkillButtonState } from "../../lib/quick-actions";

export type { SkillButtonState };

export function SkillButton({
  skill,
  state,
  onTap,
  label,
  icon,
}: {
  skill: Skill;
  state: SkillButtonState;
  onTap: () => void;
  /** Display label; defaults to skill.name (MCP tools pass a de-prefixed name). */
  label?: string;
  /** Show this glyph instead of the name and backend; the name stays the accessible label and tooltip. */
  icon?: string;
}) {
  const name = label ?? skill.name;
  return (
    <Button variant="session"
      type="button"
      className={`skill-btn skill-btn--${state}${icon === undefined ? "" : " skill-btn--icon"}`}
      aria-label={icon === undefined ? undefined : selectSkillButtonLabel(name, skill, state)}
      title={icon === undefined ? undefined : name}
      onClick={onTap}
      disabled={state === "disabled" || state === "dispatching"}
      aria-pressed={state === "collecting" || state === "confirming"}
    >
      {icon === undefined ? <>
        <span className="skill-btn__name">{name}</span>
        <span className="skill-btn__badge">{skill.backend}</span>
      </> : <span className="skill-btn__icon" aria-hidden="true">{icon}</span>}
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
    </Button>
  );
}
