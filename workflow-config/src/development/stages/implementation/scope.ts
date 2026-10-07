import { defineScope } from "../../../builder";
import { reference } from "../../../primitives/expressions";
import { implementation_dispatch } from "./decisions";
import { workers } from "./workers";

export const implementation = defineScope({
  key: "implementation",
  input_schema: "implementation_input",
  state_schema: "phase_impl",
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
      key: "accept_build",
      payload_schema: "build_target",
      available_in: ["review"],
      required: true,
      targets: [
        reference({ kind: "output_revision", key: "build_result", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      ],
      label: "Accept Build",
      consequence: "accept build",
      field_presentation: []
    },
    {
      key: "request_build_changes",
      payload_schema: "build_feedback",
      available_in: ["review"],
      required: true,
      targets: [
        reference({ kind: "output_revision", key: "build_result", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      ],
      label: "Request Build Changes",
      consequence: "request build changes",
      field_presentation: []
    },
    {
      key: "retry_build",
      payload_schema: "retry_build_target",
      available_in: ["working"],
      required: true,
      targets: [],
      label: "Retry Build",
      consequence: "retry build",
      field_presentation: []
    },
    {
      key: "accept_assessment",
      payload_schema: "assessment_target",
      available_in: ["assessment_review"],
      required: true,
      targets: [
        reference({ kind: "output_revision", key: "assessment", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "build_result", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      ],
      label: "Accept Assessment",
      consequence: "accept assessment",
      field_presentation: []
    },
    {
      key: "discuss_assessment",
      payload_schema: "assessment_feedback",
      available_in: ["assessment_review"],
      required: true,
      targets: [
        reference({ kind: "output_revision", key: "assessment", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "build_result", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      ],
      label: "Discuss Assessment",
      consequence: "discuss assessment",
      field_presentation: []
    },
    {
      key: "request_implementation_changes",
      payload_schema: "assessment_feedback",
      available_in: ["assessment_review"],
      required: true,
      targets: [
        reference({ kind: "output_revision", key: "assessment", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "build_result", schema: "revision" }, []),
        reference({ kind: "output_revision", key: "pr_summary", schema: "revision" }, [])
      ],
      label: "Request Implementation Changes",
      consequence: "request implementation changes",
      field_presentation: []
    },
    {
      key: "retry_assessment",
      payload_schema: "unit",
      available_in: ["assessing"],
      required: true,
      targets: [],
      label: "Retry Assessment",
      consequence: "retry assessment",
      field_presentation: []
    },
    {
      key: "replace_pr",
      payload_schema: "unit",
      available_in: ["review", "awaiting_merge"],
      required: true,
      targets: [],
      label: "Replace Pr",
      consequence: "replace pr",
      field_presentation: []
    },
    {
      key: "confirm_merged",
      payload_schema: "unit",
      available_in: ["awaiting_merge"],
      required: true,
      targets: [],
      label: "Confirm Merged",
      consequence: "confirm merged",
      field_presentation: []
    },
    {
      key: "cancel",
      payload_schema: "unit",
      available_in: ["ready", "working", "review", "assessing", "assessment_review", "discussing", "awaiting_merge"],
      required: true,
      targets: [],
      label: "Cancel",
      consequence: "cancel",
      field_presentation: []
    },
    {
      key: "abandon",
      payload_schema: "unit",
      available_in: ["ready", "working", "review", "assessing", "assessment_review", "discussing", "awaiting_merge"],
      required: true,
      targets: [],
      label: "Abandon",
      consequence: "abandon",
      field_presentation: []
    },
    {
      key: "refresh_pr",
      payload_schema: "unit",
      available_in: ["review", "assessment_review", "discussing", "assessing", "awaiting_merge"],
      required: true,
      targets: [],
      label: "Refresh PR evidence",
      consequence: "observe the current PR and head",
      field_presentation: []
    }
  ],
  facts: [
    { key: "session_failed", payload_schema: "text" },
    { key: "provider_start_failed", payload_schema: "text" },
    { key: "build_submitted", payload_schema: "unit" },
    { key: "assessment_submitted", payload_schema: "unit" },
    { key: "assessment_unchanged", payload_schema: "unchanged_target" },
    { key: "pr_observed", payload_schema: "pr_observe_result" },
    { key: "auth", payload_schema: "text" }
  ],
  outputs: [
    {
      key: "build_result",
      schema: "build_body",
      policy: { kind: "append_revision" },
      producers: ["build"],
      collection_key: null,
      publication_trigger: "build_submitted"
    },
    {
      key: "pr_summary",
      schema: "pr_body",
      policy: { kind: "append_revision" },
      producers: ["build"],
      collection_key: null,
      publication_trigger: "build_submitted"
    },
    {
      key: "assessment",
      schema: "assessment_body",
      policy: { kind: "append_revision" },
      producers: ["assessment"],
      collection_key: null,
      publication_trigger: "assessment_submitted"
    }
  ],
  workers: workers,
  children: [],
  exports: [
    { key: "accepted", schema: "flag" },
    { key: "integration", schema: "integration_seed" },
    { key: "completed_work", schema: "completed_work" }
  ],
  resources: [{ key: "pull_request", schema: "forge_observation" }],
  pools: [{ key: "implementation_slots", limit: 4 }],
  cancellation: { trigger: "cancel" },
  presentation: { label: "Implementation", viewer: "generic" },
  tree: implementation_dispatch,
  entry_command: "begin"
});
