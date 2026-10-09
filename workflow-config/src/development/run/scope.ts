import { defineScope } from "../../builder";
import { buildRootDispatch } from "./decisions";
import { buildStageChildren, stageTableFor } from "./stage-table";
import type { RunPolicy } from "../policies";

export function buildDevelopmentScope(policy: RunPolicy) {
  const table = stageTableFor(policy);
  return defineScope({
  key: "development",
  input_schema: policy.stage_layout === "verification" ? "run_input_verification" : "run_input",
  state_schema: "phase_root",
  initial: { kind: "ready", value: {  } },
  outcome_schema: "run_result",
  errors: [{ key: "invalid_command", payload_schema: "text" }],
  commands: [
    {
      key: "begin",
      payload_schema: "unit",
      available_in: ["ready"],
      required: true,
      targets: [],
      label: "Begin",
      consequence: "begin",
      field_presentation: []
    },
    {
      key: "cancel",
      payload_schema: "unit",
      available_in: ["ready", "preparing", "analyzing", "planning", "briefing", "implementing", "integrating"],
      required: true,
      targets: [],
      label: "Cancel",
      consequence: "cancel",
      field_presentation: []
    },
    {
      key: "abandon",
      payload_schema: "unit",
      available_in: ["ready", "preparing", "analyzing", "planning", "briefing", "implementing", "integrating"],
      required: true,
      targets: [],
      label: "Abandon",
      consequence: "abandon",
      field_presentation: []
    },
    ...(policy.stage_layout === "verification" ? [{
      key: "inspect", payload_schema: "unit", available_in: ["ready"], required: false, targets: [],
      label: "Inspect", consequence: "inspect", field_presentation: []
    }] : [])
  ],
  facts: table.map((row) => ({ key: `${row.key}_finished`, payload_schema: "unit" })),
  outputs: [],
  workers: [],
  children: buildStageChildren(table),
  exports: [],
  resources: [],
  pools: [],
  cancellation: { trigger: "cancel" },
  presentation: { label: "Development", viewer: "generic" },
  tree: buildRootDispatch(table, policy),
  entry_command: "begin"
}); }
