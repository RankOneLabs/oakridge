import { useEffect, useMemo, useState } from "react";
import type { RuntimeModelSelection } from "../../../types";
import { defaultRuntimeIdForConfig, runtimeDescriptorsForConfig, useServerConfig } from "../../../hooks/useServerConfig";
import { RoleModelPicker } from "../molecules/RoleModelPicker";
import { coerceRoleSelection } from "../../lib/runtime-selection";

interface Props {
  readonly planner: RuntimeModelSelection;
  readonly worker: RuntimeModelSelection;
  readonly onPlannerChange: (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => void;
  readonly onWorkerChange: (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => void;
  readonly isPending: boolean;
}

export function RoleSettingsFields({ planner, worker, onPlannerChange, onWorkerChange, isPending }: Props) {
  const serverConfig = useServerConfig();
  const descriptors = useMemo(() => runtimeDescriptorsForConfig(serverConfig), [serverConfig]);
  const defaultRuntimeId = useMemo(() => defaultRuntimeIdForConfig(serverConfig), [serverConfig]);
  const [plannerTouched, setPlannerTouched] = useState(false);
  const [workerTouched, setWorkerTouched] = useState(false);
  useEffect(() => { onPlannerChange((current) => coerceRoleSelection("planner", current, descriptors, defaultRuntimeId, plannerTouched)); },
    [defaultRuntimeId, descriptors, onPlannerChange, plannerTouched]);
  useEffect(() => { onWorkerChange((current) => coerceRoleSelection("worker", current, descriptors, defaultRuntimeId, workerTouched)); },
    [defaultRuntimeId, descriptors, onWorkerChange, workerTouched]);
  return <div className="or-role-grid" data-testid="or-role-settings">
    <RoleModelPicker role="planner" selection={planner} setSelection={onPlannerChange} setRuntimeTouched={setPlannerTouched}
      runtimeDescriptors={descriptors} defaultRuntimeId={defaultRuntimeId} isPending={isPending} />
    <RoleModelPicker role="worker" selection={worker} setSelection={onWorkerChange} setRuntimeTouched={setWorkerTouched}
      runtimeDescriptors={descriptors} defaultRuntimeId={defaultRuntimeId} isPending={isPending} />
  </div>;
}
