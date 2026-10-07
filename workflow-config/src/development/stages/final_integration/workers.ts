import type { WorkerDefinition } from "../../../source-contracts";
import { optional, record, reference } from "../../../primitives/expressions";

export const workers: WorkerDefinition[] = [
  {
    key: "integrator",
    result_schema: "unit",
    exclusive: true,
    actions: [
      {
        key: "initial",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "integration", value: optional("optional_integration", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "final_integration_integrator_initial",
        settings: [{ key: "evidence_fact", value: "submitted" }],
        tools: [],
        outputs: ["pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "retry",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "integration", value: optional("optional_integration", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "final_integration_integrator_retry",
        settings: [{ key: "evidence_fact", value: "submitted" }],
        tools: [],
        outputs: ["pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      }
    ]
  },
  {
    key: "pr_observer",
    result_schema: "pr_observe_result",
    exclusive: true,
    actions: [
      {
        key: "observe",
        operation: "pull_request.observe",
        contract_version: 1,
        input_schema: "pr_observe_input",
        input: record("pr_observe_input", [
          {
            key: "query",
            value: record("pr_query", [
              { key: "owner", value: reference({ kind: "input" }, ["forge", "owner"]) },
              { key: "name", value: reference({ kind: "input" }, ["forge", "name"]) },
              { key: "head_owner", value: reference({ kind: "input" }, ["push_remote_owner"]) },
              { key: "head_branch", value: reference({ kind: "output", key: "pr_summary" }, ["branch"]) },
              { key: "base_branch", value: reference({ kind: "input" }, ["forge", "final_base"]) }
            ])
          }
        ]),
        prompt: null,
        settings: [{ key: "result_fact", value: "pr_observed" }],
        tools: [],
        outputs: [],
        deadline_ms: 30000,
        max_attempts: 3
      }
    ]
  }
];
