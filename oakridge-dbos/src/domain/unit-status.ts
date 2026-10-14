import type { UnitStatus } from "../core-client/core-types";

/** The statuses a unit (and so a run, by its root) never leaves: it is no longer active. */
export const TERMINAL_UNIT_STATUSES = ["done", "cancelled"] as const satisfies readonly UnitStatus["kind"][];

export const isTerminalStatus = (status: Pick<UnitStatus, "kind">): boolean =>
  (TERMINAL_UNIT_STATUSES as readonly UnitStatus["kind"][]).includes(status.kind);

/** The run's standing is the status of its root unit. */
export const selectRootStatus = (run: { readonly root_unit_id: string | null }, units: readonly { readonly id: string; readonly status: UnitStatus }[]): UnitStatus =>
  units.find((unit) => unit.id === run.root_unit_id)?.status ?? { kind: "not_started" };
