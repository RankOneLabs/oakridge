import { defineScope } from "../../../builder";
import { reference } from "../../../primitives/expressions";
import { final_dispatch } from "./decisions";
import { workers } from "./workers";

export const final_integration = defineScope({
  key: "final_integration",
  input_schema: "integration_input",
  state_schema: "phase_final",
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
      key: "retry",
      payload_schema: "unit",
      available_in: ["working"],
      required: true,
      targets: [],
      label: "Retry",
      consequence: "retry",
      field_presentation: []
    },
    {
      key: "review_pr",
      payload_schema: "final_target",
      available_in: ["working"],
      required: true,
      targets: [reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])],
      label: "Review Pr",
      consequence: "review pr",
      field_presentation: []
    },
    {
      key: "confirm_merged",
      payload_schema: "final_target",
      available_in: ["review"],
      required: true,
      targets: [reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])],
      label: "Confirm Merged",
      consequence: "confirm merged",
      field_presentation: []
    },
    {
      key: "cancel",
      payload_schema: "unit",
      available_in: ["ready", "working", "review"],
      required: true,
      targets: [],
      label: "Cancel",
      consequence: "cancel",
      field_presentation: []
    },
    {
      key: "abandon",
      payload_schema: "unit",
      available_in: ["ready", "working", "review"],
      required: true,
      targets: [],
      label: "Abandon",
      consequence: "abandon",
      field_presentation: []
    },
    {
      key: "refresh_pr",
      payload_schema: "unit",
      available_in: ["working", "review"],
      required: true,
      targets: [],
      label: "Refresh PR evidence",
      consequence: "observe the current PR and head",
      field_presentation: []
    }
  ],
  facts: [
    { key: "submitted", payload_schema: "unit" },
    { key: "pr_observed", payload_schema: "pr_observe_result" },
    { key: "auth", payload_schema: "text" }
  ],
  outputs: [
    {
      key: "pr_summary",
      schema: "pr_body",
      policy: { kind: "append_revision" },
      producers: ["integrator"],
      collection_key: null,
      publication_trigger: "submitted"
    }
  ],
  workers: workers,
  children: [],
  exports: [{ key: "accepted", schema: "flag" }],
  resources: [{ key: "pull_request", schema: "forge_observation" }],
  pools: [],
  cancellation: { trigger: "cancel" },
  presentation: { label: "Final Integration", viewer: "generic" },
  tree: final_dispatch,
  entry_command: "begin"
});
