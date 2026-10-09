import type { WorkerDefinition } from "../../../source-contracts";
import { literal, optional, record, reference } from "../../../primitives/expressions";

export const workers: WorkerDefinition[] = [
  {
    key: "build",
    result_schema: "unit",
    exclusive: true,
    actions: [
      {
        key: "initial",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "build") },
            { key: "action_key", value: literal("ident", "initial") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "implementation_build_initial_v3",
        settings: [{ key: "evidence_fact", value: "build_submitted" }],
        tools: [],
        outputs: ["build_result", "pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "revise",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "build") },
            { key: "action_key", value: literal("ident", "revise") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              { key: "feedback", value: optional("optional_text", reference({ kind: "trigger" }, ["text"])) },
              { key: "build_result", value: optional("optional_build_body", reference({ kind: "output", key: "build_result" }, [])) },
              { key: "pr_summary", value: optional("optional_pr_body", reference({ kind: "output", key: "pr_summary" }, [])) }
            ])
          }
        ]),
        prompt: "implementation_build_revise_v3",
        settings: [{ key: "evidence_fact", value: "build_submitted" }],
        tools: [],
        outputs: ["build_result", "pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "replace_pr",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "build") },
            { key: "action_key", value: literal("ident", "replace_pr") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "implementation_build_replace_pr_v3",
        settings: [{ key: "evidence_fact", value: "build_submitted" }],
        tools: [],
        outputs: ["build_result", "pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "retry",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "build") },
            { key: "action_key", value: literal("ident", "retry") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              { key: "retained_build", value: reference({ kind: "trigger" }, ["build_result"]) },
              { key: "retained_pr", value: reference({ kind: "trigger" }, ["pr_summary"]) }
            ])
          }
        ]),
        prompt: "implementation_build_retry_v3",
        settings: [{ key: "evidence_fact", value: "build_submitted" }],
        tools: [],
        outputs: ["build_result", "pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "retry_missing_build",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "build") },
            { key: "action_key", value: literal("ident", "retry_missing_build") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              { key: "retained_build", value: reference({ kind: "trigger" }, ["build_result"]) },
              { key: "retained_pr", value: reference({ kind: "trigger" }, ["pr_summary"]) }
            ])
          }
        ]),
        prompt: "implementation_build_retry_missing_build_v3",
        settings: [{ key: "evidence_fact", value: "build_submitted" }],
        tools: [],
        outputs: ["build_result"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "retry_missing_pr",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "build") },
            { key: "action_key", value: literal("ident", "retry_missing_pr") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              { key: "retained_build", value: reference({ kind: "trigger" }, ["build_result"]) },
              { key: "retained_pr", value: reference({ kind: "trigger" }, ["pr_summary"]) }
            ])
          }
        ]),
        prompt: "implementation_build_retry_missing_pr_v3",
        settings: [{ key: "evidence_fact", value: "build_submitted" }],
        tools: [],
        outputs: ["pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "revise_after_assessment",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "build") },
            { key: "action_key", value: literal("ident", "revise_after_assessment") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              { key: "feedback", value: optional("optional_text", reference({ kind: "trigger" }, ["text"])) },
              { key: "assessment", value: optional("optional_assessment_body", reference({ kind: "output", key: "assessment" }, [])) },
              { key: "build_result", value: optional("optional_build_body", reference({ kind: "output", key: "build_result" }, [])) }
            ])
          }
        ]),
        prompt: "implementation_build_revise_after_assessment_v3",
        settings: [{ key: "evidence_fact", value: "build_submitted" }],
        tools: [],
        outputs: ["build_result", "pr_summary"],
        deadline_ms: 3600000,
        max_attempts: 2
      }
    ]
  },
  {
    key: "assessment",
    result_schema: "unit",
    exclusive: true,
    actions: [
      {
        key: "initial",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "assessment") },
            { key: "action_key", value: literal("ident", "initial") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              { key: "accepted_build", value: optional("optional_build_target", reference({ kind: "trigger" }, [])) },
              { key: "build_result", value: optional("optional_build_body", reference({ kind: "output", key: "build_result" }, [])) },
              { key: "pr_summary", value: optional("optional_pr_body", reference({ kind: "output", key: "pr_summary" }, [])) }
            ])
          }
        ]),
        prompt: "implementation_assessment_initial_v3",
        settings: [{ key: "evidence_fact", value: "assessment_submitted" }],
        tools: [],
        outputs: ["assessment"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "retry",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "assessment") },
            { key: "action_key", value: literal("ident", "retry") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              { key: "accepted_build", value: optional("optional_build_target", reference({ kind: "state" }, [])) },
              { key: "build_result", value: optional("optional_build_body", reference({ kind: "output", key: "build_result" }, [])) },
              { key: "pr_summary", value: optional("optional_pr_body", reference({ kind: "output", key: "pr_summary" }, [])) }
            ])
          }
        ]),
        prompt: "implementation_assessment_retry_v3",
        settings: [{ key: "evidence_fact", value: "assessment_submitted" }],
        tools: [],
        outputs: ["assessment"],
        deadline_ms: 3600000,
        max_attempts: 2
      },
      {
        key: "discuss",
        operation: "session.run",
        contract_version: 1,
        input_schema: "session_action",
        input: record("session_action", [
          { key: "selector", value: record("session_selector", [
            { key: "stage_key", value: literal("ident", "implementation") },
            { key: "cohort_key", value: optional("optional_ident", reference({ kind: "input" }, ["brief", "cohort_id"])) },
            { key: "worker_key", value: literal("ident", "assessment") },
            { key: "action_key", value: literal("ident", "discuss") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["repository", "build"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "implementation", value: optional("optional_implementation", reference({ kind: "input" }, [])) },
              {
                key: "accepted_build",
                value: optional("optional_build_target", record("build_target", [
                  { key: "build_result", value: reference({ kind: "trigger" }, ["build_result"]) },
                  { key: "pr_summary", value: reference({ kind: "trigger" }, ["pr_summary"]) },
                  { key: "pr_url", value: reference({ kind: "trigger" }, ["pr_url"]) },
                  { key: "head_sha", value: reference({ kind: "trigger" }, ["head_sha"]) }
                ]))
              },
              { key: "assessment", value: optional("optional_assessment_body", reference({ kind: "output", key: "assessment" }, [])) },
              { key: "feedback", value: optional("optional_text", reference({ kind: "trigger" }, ["text"])) }
            ])
          }
        ]),
        prompt: "implementation_assessment_discuss_v3",
        settings: [{ key: "evidence_fact", value: "assessment_unchanged" }],
        tools: [],
        outputs: ["assessment"],
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
              { key: "owner", value: reference({ kind: "input" }, ["repository", "forge", "owner"]) },
              { key: "name", value: reference({ kind: "input" }, ["repository", "forge", "name"]) },
              { key: "head_owner", value: reference({ kind: "input" }, ["push_remote_owner"]) },
              { key: "head_branch", value: reference({ kind: "output", key: "pr_summary" }, ["branch"]) },
              { key: "base_branch", value: reference({ kind: "input" }, ["repository", "forge", "build_base"]) }
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
