import { useEffect, useState } from "react";
import type { RuntimeId } from "../../../runtime";
import type { RuntimeDescriptors } from "../../hooks/useServerConfig";
import type { RuntimeModelSelection } from "../../types";
import type { AgentSessionTarget, SessionSelectionMap } from "../lib/agent-session-targets";
import { coerceSelection } from "../lib/launch-config";
import { initialSelectionForRole } from "../lib/runtime-selection";

/** Local launch-form choices keyed by the workflow's declared agent workers. */
export function useAgentSessionSelections(targets: readonly AgentSessionTarget[], descriptors: RuntimeDescriptors, defaultRuntimeId: RuntimeId) {
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

  const selectionFor = (target: AgentSessionTarget): RuntimeModelSelection =>
    selections[target.key] ?? initialSelectionForRole(target.suggested_role, descriptors, defaultRuntimeId);
  const setSelectionFor = (target: AgentSessionTarget) => (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => {
    setSelections((current) => {
      const previous = current[target.key] ?? selectionFor(target);
      return { ...current, [target.key]: typeof value === "function" ? value(previous) : value };
    });
  };
  const touchRuntimeFor = (target: AgentSessionTarget) => (isTouched: boolean) => {
    setTouched((current) => {
      const next = new Set(current);
      if (isTouched) next.add(target.key);
      else next.delete(target.key);
      return next;
    });
  };
  return { selections, selectionFor, setSelectionFor, touchRuntimeFor };
}
