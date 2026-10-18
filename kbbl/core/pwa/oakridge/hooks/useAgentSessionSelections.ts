import { useEffect, useState } from "react";
import type { RuntimeId } from "../../../runtime";
import type { RuntimeDescriptors } from "../../hooks/useServerConfig";
import type { RuntimeModelSelection } from "../../types";
import type { ModelChoiceTarget, SessionSelectionMap } from "../lib/agent-session-targets";
import { coerceSelection } from "../lib/launch-config";
import { initialSelectionForRole } from "../lib/runtime-selection";

export type ModelChoices = ReturnType<typeof useAgentSessionSelections>;

/** Local launch-form choices keyed by their targets: declared agent workers, or roles. */
export function useAgentSessionSelections(targets: readonly ModelChoiceTarget[], descriptors: RuntimeDescriptors, defaultRuntimeId: RuntimeId) {
  const [selections, setSelections] = useState<SessionSelectionMap>({});
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    setSelections((current) => {
      const next: { [key: string]: RuntimeModelSelection } = {};
      let hasChange = Object.keys(current).length !== targets.length;
      for (const target of targets) {
        const previous = current[target.key] ?? initialSelectionForRole(target.suggested_role, descriptors, defaultRuntimeId);
        const selection = coerceSelection(target.suggested_role, previous, descriptors, defaultRuntimeId, touched.has(target.key));
        next[target.key] = selection;
        if (selection !== current[target.key]) hasChange = true;
      }
      return hasChange ? next : current;
    });
  }, [targets, descriptors, defaultRuntimeId, touched]);

  const selectionFor = (target: ModelChoiceTarget): RuntimeModelSelection =>
    selections[target.key] ?? initialSelectionForRole(target.suggested_role, descriptors, defaultRuntimeId);
  const setSelectionFor = (target: ModelChoiceTarget) => (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => {
    setSelections((current) => {
      const previous = current[target.key] ?? selectionFor(target);
      return { ...current, [target.key]: typeof value === "function" ? value(previous) : value };
    });
  };
  const touchRuntimeFor = (target: ModelChoiceTarget) => (isTouched: boolean) => {
    setTouched((current) => {
      const next = new Set(current);
      if (isTouched) next.add(target.key);
      else next.delete(target.key);
      return next;
    });
  };
  /** Replace every choice, e.g. to start per-session choices from the role choices. */
  const seed = (next: SessionSelectionMap, touched_keys: ReadonlySet<string>) => {
    setSelections(next);
    setTouched(touched_keys);
  };
  return { selections, touched, selectionFor, setSelectionFor, touchRuntimeFor, seed };
}
