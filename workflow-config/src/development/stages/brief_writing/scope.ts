import { defineScope } from "../../../builder";
import { reference } from "../../../primitives/expressions";
import { brief_dispatch } from "./decisions";
import { workers } from "./workers";

export const brief_writing = defineScope({
  key: "brief_writing",
  input_schema: "task_input",
  state_schema: "phase_review",
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
      key: "accept",
      payload_schema: "brief_review",
      available_in: ["review"],
      required: true,
      targets: [reference({ kind: "output_revisions", key: "briefs", schema: "revisions" }, [])],
      label: "Accept",
      consequence: "accept",
      field_presentation: []
    },
    {
      key: "request_changes",
      payload_schema: "brief_feedback",
      available_in: ["review"],
      required: true,
      targets: [reference({ kind: "output_revisions", key: "briefs", schema: "revisions" }, [])],
      label: "Request Changes",
      consequence: "request changes",
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
      key: "briefs",
      schema: "brief_body",
      policy: { kind: "append_revision" },
      producers: ["author"],
      collection_key: "cohort_id",
      publication_trigger: "submitted"
    }
  ],
  workers: workers,
  children: [],
  exports: [{ key: "accepted", schema: "flag" }, { key: "briefs", schema: "brief_bodies" }],
  resources: [],
  pools: [],
  cancellation: { trigger: "cancel" },
  presentation: { label: "Brief Writing", viewer: "generic" },
  tree: brief_dispatch,
  entry_command: "begin"
});
