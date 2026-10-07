import type { WorkerDefinition } from "../../../source-contracts";
import { optional, record, reference } from "../../../primitives/expressions";

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
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "task", value: optional("optional_task", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "brief_writing_author_initial",
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
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [
              { key: "task", value: optional("optional_task", reference({ kind: "input" }, [])) },
              { key: "feedback", value: optional("optional_text", reference({ kind: "trigger" }, ["text"])) }
            ])
          }
        ]),
        prompt: "brief_writing_author_revise",
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
          { key: "config", value: reference({ kind: "input" }, ["config"]) },
          {
            key: "context",
            value: record("session_context", [{ key: "task", value: optional("optional_task", reference({ kind: "input" }, [])) }])
          }
        ]),
        prompt: "brief_writing_author_retry",
        settings: [{ key: "evidence_fact", value: "submitted" }],
        tools: [],
        outputs: ["briefs"],
        deadline_ms: 3600000,
        max_attempts: 2
      }
    ]
  }
];
