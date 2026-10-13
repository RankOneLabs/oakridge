import type { RoleSelection } from "../../lib/runtime-selection";
import { defaultRuntimeIdForConfig, runtimeDescriptorsForConfig, type ServerConfig } from "../../../hooks/useServerConfig";
import { RoleModelPicker } from "../molecules/RoleModelPicker";

interface Props {
  readonly serverConfig: ServerConfig;
  readonly planner: RoleSelection;
  readonly worker: RoleSelection;
  readonly onPlannerChange: (value: RoleSelection | ((current: RoleSelection) => RoleSelection)) => void;
  readonly onWorkerChange: (value: RoleSelection | ((current: RoleSelection) => RoleSelection)) => void;
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
