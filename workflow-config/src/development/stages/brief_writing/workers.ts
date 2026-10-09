import type { WorkerDefinition } from "../../../source-contracts";
import { literal, optional, record, reference } from "../../../primitives/expressions";

export const workers: WorkerDefinition[] = [
  {
    key: "author",
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
            { key: "stage_key", value: literal("ident", "brief_writing") },
            { key: "cohort_key", value: optional("optional_ident", null) },
            { key: "worker_key", value: literal("ident", "author") },
            { key: "action_key", value: literal("ident", "initial") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "task", value: optional("optional_task", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "brief_writing_author_initial_v3",
        settings: [{ key: "evidence_fact", value: "submitted" }],
        tools: [],
        outputs: ["briefs"],
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
            { key: "stage_key", value: literal("ident", "brief_writing") },
            { key: "cohort_key", value: optional("optional_ident", null) },
            { key: "worker_key", value: literal("ident", "author") },
            { key: "action_key", value: literal("ident", "revise") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "task", value: optional("optional_task", reference({ kind: "input" }, [])) },
              { key: "feedback", value: optional("optional_text", reference({ kind: "trigger" }, ["text"])) }
            ])
          }
        ]),
        prompt: "brief_writing_author_revise_v3",
        settings: [{ key: "evidence_fact", value: "submitted" }],
        tools: [],
        outputs: ["briefs"],
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
            { key: "stage_key", value: literal("ident", "brief_writing") },
            { key: "cohort_key", value: optional("optional_ident", null) },
            { key: "worker_key", value: literal("ident", "author") },
            { key: "action_key", value: literal("ident", "retry") }
          ]) },
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "task", value: optional("optional_task", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "brief_writing_author_retry_v3",
        settings: [{ key: "evidence_fact", value: "submitted" }],
        tools: [],
        outputs: ["briefs"],
        deadline_ms: 3600000,
        max_attempts: 2
      }
    ]
  }
];
