import { defineScope } from "../../../builder";
import { reference } from "../../../primitives/expressions";
import { planning_dispatch } from "./decisions";
import { workers } from "./workers";

export const planning = defineScope({
  key: "planning",
  input_schema: "task_input",
  state_schema: "phase_review",
  initial: { kind: "ready", value: {  } },
  outcome_schema: "result",
  errors: [{ key: "invalid_command", payload_schema: "text" }],
  commands: [
    { key: "admit", payload_schema: "unit", available_in: ["waiting_admission"], required: true, targets: [],
      label: "Admit", consequence: "admit", field_presentation: [] },
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
      key: "accept",
      payload_schema: "revision_target",
      available_in: ["review"],
      required: true,
      targets: [reference({ kind: "output_revision", key: "plan", schema: "revision" }, [])],
      label: "Accept",
      consequence: "accept",
      field_presentation: [],
      prefill: [{ key: "revision", value: reference({ kind: "output_revision", key: "plan", schema: "revision" }, []) }]
    },
    { key: "edit_plan", payload_schema: "unit", available_in: ["review"], required: false,
      targets: [], label: "Edit plan", consequence: "publish an edited plan", field_presentation: [] },
    {
      key: "request_changes",
      payload_schema: "feedback",
      available_in: ["review"],
      required: true,
      targets: [reference({ kind: "output_revision", key: "plan", schema: "revision" }, [])],
      label: "Request Changes",
      consequence: "request changes",
      field_presentation: [],
      prefill: [{ key: "revision", value: reference({ kind: "output_revision", key: "plan", schema: "revision" }, []) }]
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
    }
  ],
  facts: [{ key: "submitted", payload_schema: "unit" }, { key: "session_failed", payload_schema: "text" }],
  outputs: [
    {
      key: "plan",
      schema: "plan_body",
      policy: { kind: "append_revision" },
      producers: ["author"],
      collection_key: null,
      publication_trigger: "submitted",
      edit_trigger: "edit_plan"
    }
  ],
  workers: workers,
  children: [],
  exports: [{ key: "accepted", schema: "flag" }, { key: "body", schema: "plan_body" }],
  resources: [],
  pools: [],
  cancellation: { trigger: "cancel" },
  presentation: { label: "Planning", viewer: "generic" },
  tree: planning_dispatch,
  entry_command: "begin"
});
