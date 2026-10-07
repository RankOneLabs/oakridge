import { defineScope } from "../../../builder";
import { prepare_dispatch } from "./decisions";
import { workers } from "./workers";

export const repository_preparation = defineScope({
  key: "repository_preparation",
  input_schema: "repo_input",
  state_schema: "phase_simple",
  initial: { kind: "ready", value: {  } },
  outcome_schema: "result",
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
      key: "retry_preparation",
      payload_schema: "unit",
      available_in: ["working"],
      required: true,
      targets: [],
      label: "Retry Preparation",
      consequence: "retry preparation",
      field_presentation: []
    },
    {
      key: "cancel",
      payload_schema: "unit",
      available_in: ["ready", "working"],
      required: true,
      targets: [],
      label: "Cancel",
      consequence: "cancel",
      field_presentation: []
    },
    {
      key: "abandon",
      payload_schema: "unit",
      available_in: ["ready", "working"],
      required: true,
      targets: [],
      label: "Abandon",
      consequence: "abandon",
      field_presentation: []
    }
  ],
  facts: [{ key: "prepared", payload_schema: "repo_result" }],
  outputs: [],
  workers: workers,
  children: [],
  exports: [{ key: "references", schema: "repo_result" }],
  resources: [],
  pools: [],
  cancellation: { trigger: "cancel" },
  presentation: { label: "Repository Preparation", viewer: "generic" },
  tree: prepare_dispatch,
  entry_command: "begin"
});
