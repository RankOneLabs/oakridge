import { defineScope } from "../../builder";
import { literal, optional, record, reference, variant } from "../../primitives/expressions";
import { root_dispatch } from "./decisions";

export const development = defineScope({
  key: "development",
  input_schema: "run_input",
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
    }
  ],
  facts: [
    { key: "prepare_finished", payload_schema: "unit" },
    { key: "analysis_finished", payload_schema: "unit" },
    { key: "plan_finished", payload_schema: "unit" },
    { key: "briefs_finished", payload_schema: "unit" },
    { key: "implementation_finished", payload_schema: "unit" },
    { key: "integration_finished", payload_schema: "unit" }
  ],
  outputs: [],
  workers: [],
  children: [
    {
      key: "prepare",
      scope: "repository_preparation",
      input: reference({ kind: "item" }, ["input"]),
      depends_on: [],
      imports: ["references"],
      collection: {
        source: {
          kind: "map",
          source: reference({ kind: "input" }, ["repositories"]),
          schema: "prepare_members",
          value: record("prepare_member", [
            { key: "key", value: reference({ kind: "item" }, ["key"]) },
            { key: "input", value: reference({ kind: "item" }, ["preparation"]) },
            { key: "dependencies", value: literal("ids", []) }
          ])
        },
        key_field: "key",
        input_field: "input",
        dependencies_field: "dependencies",
        min_items: 1,
        max_items: 100,
        empty: { kind: "complete", outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) }) }
      },
      on_terminal: "prepare_finished"
    },
    {
      key: "analysis",
      scope: "spec_analysis",
      input: record("task_input", [
        { key: "config", value: reference({ kind: "input" }, ["analysis"]) },
        { key: "spec", value: reference({ kind: "input" }, ["spec"]) },
        { key: "repositories", value: reference({ kind: "input" }, ["repositories"]) },
        {
          key: "repository_refs",
          value: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, [])
        },
        { key: "analysis", value: optional("optional_analysis", null) },
        { key: "plan", value: optional("optional_plan", null) }
      ]),
      depends_on: ["prepare"],
      imports: ["accepted", "body"],
      collection: null,
      on_terminal: "analysis_finished"
    },
    {
      key: "plan",
      scope: "planning",
      input: record("task_input", [
        { key: "config", value: reference({ kind: "input" }, ["planning"]) },
        { key: "spec", value: reference({ kind: "input" }, ["spec"]) },
        { key: "repositories", value: reference({ kind: "input" }, ["repositories"]) },
        {
          key: "repository_refs",
          value: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, [])
        },
        { key: "analysis", value: optional("optional_analysis", reference({ kind: "child", key: "analysis", export: "body" }, [])) },
        { key: "plan", value: optional("optional_plan", null) }
      ]),
      depends_on: ["analysis", "prepare"],
      imports: ["accepted", "body"],
      collection: null,
      on_terminal: "plan_finished"
    },
    {
      key: "briefs",
      scope: "brief_writing",
      input: record("task_input", [
        { key: "config", value: reference({ kind: "input" }, ["briefs"]) },
        { key: "spec", value: reference({ kind: "input" }, ["spec"]) },
        { key: "repositories", value: reference({ kind: "input" }, ["repositories"]) },
        {
          key: "repository_refs",
          value: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, [])
        },
        { key: "analysis", value: optional("optional_analysis", reference({ kind: "child", key: "analysis", export: "body" }, [])) },
        { key: "plan", value: optional("optional_plan", reference({ kind: "child", key: "plan", export: "body" }, [])) }
      ]),
      depends_on: ["plan", "prepare"],
      imports: ["accepted", "briefs"],
      collection: null,
      on_terminal: "briefs_finished"
    },
    {
      key: "implementation",
      scope: "implementation",
      input: reference({ kind: "item" }, ["input"]),
      depends_on: ["briefs", "prepare"],
      imports: ["accepted", "integration", "completed_work"],
      collection: {
        source: {
          kind: "map",
          source: reference({ kind: "child", key: "briefs", export: "briefs" }, []),
          schema: "implementation_members",
          value: record("implementation_member", [
            { key: "key", value: reference({ kind: "item" }, ["cohort_id"]) },
            {
              key: "input",
              value: record("implementation_input", [
                { key: "brief", value: reference({ kind: "item" }, []) },
                {
                  key: "repository",
                  value: {
                    kind: "lookup",
                    source: reference({ kind: "input" }, ["repositories"]),
                    key_field: "key",
                    key: reference({ kind: "item" }, ["repository_key"])
                  }
                },
                {
                  key: "push_remote_owner",
                  value: {
                    kind: "field",
                    value: {
                      kind: "lookup",
                      source: reference({ kind: "children", key: "prepare", export: "references", schema: "repository_refs" }, []),
                      key_field: "repository_path",
                      key: {
                        kind: "field",
                        value: {
                          kind: "field",
                          value: {
                            kind: "lookup",
                            source: reference({ kind: "input" }, ["repositories"]),
                            key_field: "key",
                            key: reference({ kind: "item" }, ["repository_key"])
                          },
                          key: "preparation"
                        },
                        key: "repository_path"
                      }
                    },
                    key: "push_remote_owner"
                  }
                }
              ])
            },
            { key: "dependencies", value: reference({ kind: "item" }, ["depends_on"]) }
          ])
        },
        key_field: "key",
        input_field: "input",
        dependencies_field: "dependencies",
        min_items: 0,
        max_items: 100,
        empty: { kind: "complete", outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) }) }
      },
      on_terminal: "implementation_finished",
      prerequisite_export: "accepted"
    },
    {
      key: "integration",
      scope: "final_integration",
      input: reference({ kind: "item" }, ["input"]),
      depends_on: ["implementation", "prepare"],
      imports: ["accepted"],
      collection: {
        source: {
          kind: "map",
          source: {
            kind: "unique_by",
            source: reference({ kind: "children", key: "implementation", export: "integration", schema: "integration_seeds" }, []),
            key_field: "repository_key"
          },
          schema: "integration_members",
          value: record("integration_member", [
            { key: "key", value: reference({ kind: "item" }, ["repository_key"]) },
            {
              key: "input",
              value: record("integration_input", [
                { key: "repository_key", value: reference({ kind: "item" }, ["repository_key"]) },
                { key: "config", value: reference({ kind: "item" }, ["config"]) },
                {
                  key: "completed_work",
                  value: {
                    kind: "filter_by",
                    source: reference({ kind: "children", key: "implementation", export: "completed_work", schema: "completed_works" }, []),
                    key_field: "repository_key",
                    key: reference({ kind: "item" }, ["repository_key"])
                  }
                },
                { key: "forge", value: reference({ kind: "item" }, ["forge"]) },
                { key: "push_remote_owner", value: reference({ kind: "item" }, ["push_remote_owner"]) }
              ])
            },
            { key: "dependencies", value: literal("ids", []) }
          ])
        },
        key_field: "key",
        input_field: "input",
        dependencies_field: "dependencies",
        min_items: 0,
        max_items: 100,
        empty: { kind: "complete", outcome: variant({ schema: "run_result", variant: "complete", value: literal("unit", {}) }) }
      },
      on_terminal: "integration_finished"
    }
  ],
  exports: [],
  resources: [],
  pools: [],
  cancellation: { trigger: "cancel" },
  presentation: { label: "Development", viewer: "generic" },
  tree: root_dispatch,
  entry_command: "begin"
});
