import type { RuntimeModelSelection } from "../../../types";
import { defaultRuntimeIdForConfig, runtimeDescriptorsForConfig, type ServerConfig } from "../../../hooks/useServerConfig";
import { RoleModelPicker } from "../molecules/RoleModelPicker";

interface Props {
  readonly serverConfig: ServerConfig;
  readonly planner: RuntimeModelSelection;
  readonly worker: RuntimeModelSelection;
  readonly onPlannerChange: (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => void;
  readonly onWorkerChange: (value: RuntimeModelSelection | ((current: RuntimeModelSelection) => RuntimeModelSelection)) => void;
  readonly onPlannerRuntimeTouched: (isTouched: boolean) => void;
  readonly onWorkerRuntimeTouched: (isTouched: boolean) => void;
  readonly isPending: boolean;
}

export function RoleSettingsFields({ serverConfig, planner, worker, onPlannerChange, onWorkerChange,
  onPlannerRuntimeTouched, onWorkerRuntimeTouched, isPending }: Props) {
  const descriptors = runtimeDescriptorsForConfig(serverConfig);
  const defaultRuntimeId = defaultRuntimeIdForConfig(serverConfig);
  return <div className="or-role-grid" data-testid="or-role-settings">
    <RoleModelPicker role="planner" selection={planner} setSelection={onPlannerChange} setRuntimeTouched={onPlannerRuntimeTouched}
      runtimeDescriptors={descriptors} defaultRuntimeId={defaultRuntimeId} isPending={isPending} />
    <RoleModelPicker role="worker" selection={worker} setSelection={onWorkerChange} setRuntimeTouched={onWorkerRuntimeTouched}
      runtimeDescriptors={descriptors} defaultRuntimeId={defaultRuntimeId} isPending={isPending} />
  </div>;
}
