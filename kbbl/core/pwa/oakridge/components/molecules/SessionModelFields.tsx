import type { RuntimeId } from "../../../../runtime";
import type { RuntimeDescriptors } from "../../../hooks/useServerConfig";
import type { ModelChoices } from "../../hooks/useAgentSessionSelections";
import type { AgentSessionTarget, RoleChoiceTarget, SessionModelMode } from "../../lib/agent-session-targets";
import { Button } from "../../../components/atoms/Button";
import { RoleModelPicker } from "./RoleModelPicker";

interface RuntimeChoices {
  readonly descriptors: RuntimeDescriptors;
  readonly default_id: RuntimeId;
}

interface SessionModelFieldsProps {
  mode: SessionModelMode;
  onModeChange: (mode: SessionModelMode) => void;
  roleTargets: readonly RoleChoiceTarget[];
  roleChoices: ModelChoices;
  sessionTargets: readonly AgentSessionTarget[];
  sessionChoices: ModelChoices;
  runtimes: RuntimeChoices;
  disabled: boolean;
}

/**
 * Agent models, by role or by session. Both produce the same per-session
 * settings at launch; by role only decides them from two pickers.
 *
 * A fieldset with a button-pair toggle, like BriefNotesField, so a click on a
 * toggle never activates a labelled control.
 */
export function SessionModelFields({ mode, onModeChange, roleTargets, roleChoices, sessionTargets, sessionChoices, runtimes, disabled }: SessionModelFieldsProps) {
  const isByRole = mode === "by_role";
  const choices = isByRole ? roleChoices : sessionChoices;
  const targets: readonly (RoleChoiceTarget | AgentSessionTarget)[] = isByRole ? roleTargets : sessionTargets;
  return (
    <fieldset className="flex flex-col gap-2" data-testid="session-model-fields">
      <legend className="mb-1 flex w-full items-center justify-between gap-3">
        <span className="text-xs font-medium text-[var(--text-muted)]">Agent models</span>
        <span role="group" aria-label="Agent model mode" className="flex gap-1">
          <Button size="small" variant={isByRole ? "primary" : "secondary"} aria-pressed={isByRole}
            disabled={disabled} onClick={() => onModeChange("by_role")}>
            Planner &amp; worker
          </Button>
          <Button size="small" variant={isByRole ? "secondary" : "primary"} aria-pressed={!isByRole}
            disabled={disabled} onClick={() => onModeChange("by_session")}>
            Per session
          </Button>
        </span>
      </legend>
      <div className="or-role-grid">
        {targets.map((target) => <div key={target.key} className="flex flex-col gap-1">
          <RoleModelPicker
            role={target.suggested_role}
            label={target.label}
            selection={choices.selectionFor(target)}
            setSelection={choices.setSelectionFor(target)}
            setRuntimeTouched={choices.touchRuntimeFor(target)}
            runtimeDescriptors={runtimes.descriptors}
            defaultRuntimeId={runtimes.default_id}
            isPending={disabled}
          />
          {"covers" in target && <span className="text-xs text-[var(--text-muted)]">{target.covers.join(", ")}</span>}
        </div>)}
      </div>
    </fieldset>
  );
}
